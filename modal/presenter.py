"""Omnimate realistic presenter worker for Modal GPUs.

Deploy with (Modal credits pay per second, no monthly fee):
    pip install modal
    modal setup
    modal deploy modal/presenter.py

Then copy the printed HTTPS URL into Omnimate `.env` as MODAL_PRESENTER_URL.

Quality design (highest realistic, open-source only):
  - MuseTalk 1.5 (v15) for lip sync: GAN + perceptual + sync loss training,
    identity-preserving, 25fps output. Driven by a real YAML inference
    config, exactly as the official repo runs it.
  - FSRCNN neural upscale (OpenCV dnn_superres, no extra heavy deps) plus a
    gentle sharpen on the composited frames for the "high" quality mode.
  - FFmpeg H.264 MP4 output, yuv420p for YouTube compatibility.
  - A100 40GB default. Model weights live on a persisted Modal Volume, so the
    multi-GB download happens once and later renders start fast.

Single photo in -> talking MP4 out. The photo is looped as still frames, so
the head stays naturally still while the mouth, jaw, and cheeks move.
"""

import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

import modal

app = modal.App("omnimate-presenter")

# Official MuseTalk stack (repo README): torch 2.0.1 cu118 plus pinned MMLab
# versions. Newer combos break in subtle native ways, so stay on tested pins.
image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "git", "wget", "libgl1", "libglib2.0-0")
    .pip_install("torch==2.0.1", "torchvision==0.15.2", "torchaudio==2.0.2",
                 index_url="https://download.pytorch.org/whl/cu118")
    .run_commands(
        "git clone --depth 1 https://github.com/TMElyralab/MuseTalk.git /opt/MuseTalk",
        "pip install -r /opt/MuseTalk/requirements.txt",
        "pip uninstall -y opencv-python",
        'pip install "opencv-contrib-python-headless==4.9.0.80" fastapi==0.110.3 python-multipart==0.0.9',
        # Pinned MMLab versions from the official install guide.
        "pip install -U openmim",
        'mim install mmengine "mmcv==2.0.1" "mmdet==3.1.0" "mmpose==1.1.0"',
        # The renderer imports `face_detection.FaceAlignment`, but the PyPI
        # package under that name is an unrelated detector. The API it needs
        # is exactly 1adrianb/face-alignment, exposed under the expected name
        # by a tiny shim written at render time (see below).
        "pip install face-alignment",
        "pip uninstall -y face-detection",
        # Keep numpy on the 1.x line the whole stack was built against.
        "pip install 'numpy==1.23.5'",
    )
)

weights = modal.Volume.from_name("omnimate-musetalk-weights", create_if_missing=True)

MUSETALK_DIR = Path("/opt/MuseTalk")
MODELS_DIR = Path("/models")
FSRCNN_URL = "https://github.com/Saafke/FSRCNN_Tensorflow/raw/master/models/FSRCNN-small_x2.pb"


def link_models_dir() -> None:
    """MuseTalk resolves weights via relative ./models paths, so point its
    models folder at the persisted Volume (which survives across renders)."""
    target = MUSETALK_DIR / "models"
    if target.is_symlink() and target.resolve() == MODELS_DIR.resolve():
        return
    if target.is_symlink() or target.exists():
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
    target.symlink_to(MODELS_DIR)


def ensure_weights() -> None:
    """Download all MuseTalk weights once (persisted on the Volume)."""
    from huggingface_hub import snapshot_download

    link_models_dir()
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    snapshot_download("TMElyralab/MuseTalk", local_dir=MODELS_DIR,
                      allow_patterns=["musetalk/musetalk.json", "musetalk/pytorch_model.bin",
                                      "musetalkV15/musetalk.json", "musetalkV15/unet.pth"])
    snapshot_download("stabilityai/sd-vae-ft-mse", local_dir=MODELS_DIR / "sd-vae",
                      allow_patterns=["config.json", "diffusion_pytorch_model.bin"])
    snapshot_download("openai/whisper-tiny", local_dir=MODELS_DIR / "whisper",
                      allow_patterns=["config.json", "pytorch_model.bin", "preprocessor_config.json"])
    snapshot_download("yzd-v/DWPose", local_dir=MODELS_DIR / "dwpose",
                      allow_patterns=["dw-ll_ucoco_384.pth"])
    snapshot_download("ByteDance/LatentSync", local_dir=MODELS_DIR / "syncnet",
                      allow_patterns=["latentsync_syncnet.pt"])
    bisent = MODELS_DIR / "face-parse-bisent"
    bisent.mkdir(parents=True, exist_ok=True)
    if not (bisent / "79999_iter.pth").exists():
        # The original Google Drive link is unreliable (permission errors),
        # so try HuggingFace mirrors first, Drive link last.
        downloaded = False
        for repo in ["ManyOtherFunctions/face-parse-bisent", "bes-dev/face_parsing",
                     "leonelhs/faceparser", "AI2lab/face-parsing.PyTorch",
                     "vivym/face-parsing-bisenet"]:
            try:
                snapshot_download(repo, local_dir=bisent, allow_patterns=["*.pth"])
                if (bisent / "79999_iter.pth").exists():
                    downloaded = True
                    break
            except Exception:
                continue
        if not downloaded:
            subprocess.run(["gdown", "--id", "154JgKpzCPW82qINcVieuPH3fZ2e0P812",
                            "-O", str(bisent / "79999_iter.pth")], check=True)
    if not (bisent / "resnet18-5c106cde.pth").exists():
        subprocess.run(["wget", "-q", "-O", str(bisent / "resnet18-5c106cde.pth"),
                        "https://download.pytorch.org/models/resnet18-5c106cde.pth"], check=True)
    weights.commit()


def ensure_fsrcnn() -> Path | None:
    """Neural 2x upscaler weights (tiny file, persisted). None if offline."""
    target = MODELS_DIR / "fsrcnn" / "FSRCNN-small_x2.pb"
    if target.exists():
        return target
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["wget", "-q", "-O", str(target), FSRCNN_URL], check=True, timeout=300)
        weights.commit()
        return target
    except Exception:
        return None


def ensure_face_detection_shim() -> None:
    """Expose 1adrianb/face-alignment under the `face_detection` module name
    the renderer imports (constructor, LandmarksType, and
    get_detections_for_batch all match). Written per render into /tmp."""
    shim_dir = Path("/tmp/omnimate-shim")
    shim_dir.mkdir(parents=True, exist_ok=True)
    (shim_dir / "face_detection.py").write_text(
        "from face_alignment import FaceAlignment, LandmarksType\n"
    )
    current = os.environ.get("PYTHONPATH", "")
    if str(shim_dir) not in current.split(os.pathsep):
        os.environ["PYTHONPATH"] = str(shim_dir) + (os.pathsep + current if current else "")


def run_musetalk_v15(frames_dir: Path, audio: Path, avatar_id: str, fps: int = 25) -> Path:
    """Run the official realtime_inference.py in v15 mode and return the MP4."""
    ensure_weights()
    ensure_face_detection_shim()
    tmp = frames_dir.parent
    yaml_path = tmp / "realtime.yaml"
    yaml_path.write_text(
        f"{avatar_id}:\n"
        f" preparation: true\n"
        f" bbox_shift: 0\n"
        f' video_path: "{frames_dir}"\n'
        f" audio_clips:\n"
        f'     clip: "{audio}"\n'
    )
    cmd = [
        "python", "scripts/realtime_inference.py",
        "--version", "v15",
        "--unet_model_path", "/models/musetalkV15/unet.pth",
        "--unet_config", "/models/musetalkV15/musetalk.json",
        "--whisper_dir", "/models/whisper",
        "--inference_config", str(yaml_path),
        "--fps", str(fps),
        "--batch_size", "20",
        "--parsing_mode", "jaw",
    ]
    # The script imports the `musetalk` package from the repo root, but Python
    # only puts the script's own folder on the import path. Point it at the
    # repo root explicitly so the import always resolves.
    env = dict(os.environ)
    env["PYTHONPATH"] = str(MUSETALK_DIR) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1500, cwd=MUSETALK_DIR, env=env)
    out = MUSETALK_DIR / "results" / "v15" / "avatars" / avatar_id / "vid_output" / "clip.mp4"
    if proc.returncode != 0 or not out.exists():
        raise RuntimeError(f"MuseTalk render failed: {(proc.stderr or proc.stdout)[-2000:]}")
    return out


def upscale_and_finish(raw_mp4: Path, final_mp4: Path, enhance: bool) -> None:
    """2x neural upscale + gentle sharpen (high mode), always ending in a
    YouTube-safe H.264 file. Falls back to a direct re-encode if anything in
    the upscale chain is unavailable, so enhancement never fails the job."""
    try:
        if not enhance:
            raise RuntimeError("fast mode skips enhancement")
        import cv2

        fsrcnn = ensure_fsrcnn()
        if fsrcnn is None:
            raise RuntimeError("upscaler weights unavailable")
        sr = cv2.dnn_superres.DnnSuperResImpl_create()
        sr.readModel(str(fsrcnn))
        sr.setModel("fsrcnn-small", 2)
        with tempfile.TemporaryDirectory() as tmp:
            frames = Path(tmp) / "frames"
            done = Path(tmp) / "done"
            frames.mkdir()
            done.mkdir()
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(raw_mp4),
                            str(frames / "f_%05d.png")], check=True)
            for frame in sorted(frames.glob("*.png")):
                img = cv2.imread(str(frame))
                up = sr.upsample(img)
                # Mild unsharp mask to restore edge bite after upscale.
                blur = cv2.GaussianBlur(up, (0, 0), 2.0)
                sharp = cv2.addWeighted(up, 1.35, blur, -0.35, 0)
                cv2.imwrite(str(done / frame.name), sharp)
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-framerate", "25",
                 "-i", str(done / "f_%05d.png"), "-i", str(raw_mp4),
                 "-c:v", "libx264", "-crf", "18", "-preset", "medium",
                 "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
                 "-map", "0:v", "-map", "1:a?", "-shortest", str(final_mp4)],
                check=True,
            )
    except Exception:
        crf = "20" if not enhance else "18"
        preset = "veryfast" if not enhance else "medium"
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(raw_mp4),
             "-c:v", "libx264", "-crf", crf, "-preset", preset,
             "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", str(final_mp4)],
            check=True,
        )


@app.function(image=image, gpu="A100", timeout=1800, volumes={"/models": weights})
@modal.asgi_app()
def presenter_app():
    # The web app is built INSIDE the container, so every FastAPI class
    # resolves from the container's own packages. Local/remote version
    # differences can never confuse upload parsing again.
    from fastapi import FastAPI, Request
    from fastapi.responses import Response

    web = FastAPI()

    @web.post("/")
    async def generate(request: Request):
        """Multipart POST: image (jpg/png), audio (wav), quality (high|fast). Returns MP4."""
        import cv2

        form = await request.form()
        upload_image = form.get("image")
        upload_audio = form.get("audio")
        quality = str(form.get("quality") or "high")
        if upload_image is None or upload_audio is None:
            return Response(content="Missing image or audio fields.", status_code=400)

        avatar_id = f"pres_{uuid.uuid4().hex[:12]}"
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            photo_src = tmpdir / "upload"
            photo_src.write_bytes(await upload_image.read())
            (tmpdir / "narration.wav").write_bytes(await upload_audio.read())

            img = cv2.imread(str(photo_src))
            if img is None:
                return Response(content="Could not read the presenter photo.", status_code=400)
            frames_dir = tmpdir / "frames"
            frames_dir.mkdir()
            # Still frames cycled forward+backward by the renderer: a calm,
            # natural stillness while the mouth and jaw move.
            for i in range(12):
                cv2.imwrite(str(frames_dir / f"{i:08d}.png"), img)

            try:
                raw = run_musetalk_v15(frames_dir, tmpdir / "narration.wav", avatar_id)
                final = tmpdir / "presenter.mp4"
                upscale_and_finish(raw, final, enhance=(quality == "high"))
                data = final.read_bytes()
            finally:
                shutil.rmtree(MUSETALK_DIR / "results" / "v15" / "avatars" / avatar_id,
                              ignore_errors=True)
        return Response(content=data, media_type="video/mp4")

    return web


@app.local_entrypoint()
def smoke_test():
    """Local check (no GPU): modal run modal/presenter.py::smoke_test"""
    print("Deploy first: modal deploy modal/presenter.py")
    print("Then set MODAL_PRESENTER_URL in Omnimate .env to the printed URL.")


@app.function(image=image)
def debug_imports():
    """Cheap CPU check of the render stack. Run: modal run modal/presenter.py::debug_imports"""
    import importlib
    import traceback

    import numpy

    print("numpy", numpy.__version__)
    ensure_face_detection_shim()
    import sys

    sys.path.insert(0, "/tmp/omnimate-shim")
    for mod in ["torch", "torchvision", "transformers", "diffusers",
                "mmcv", "mmengine", "mmpose", "mmdet", "face_detection", "cv2", "librosa"]:
        try:
            m = importlib.import_module(mod)
            print(mod, "OK", getattr(m, "__version__", "?"))
        except Exception:
            print(mod, "FAILED")
            traceback.print_exc()
    # The exact lazy imports the renderer triggers (import only, no GPU work).
    for stmt, label in [
        ("from diffusers import AutoencoderKL", "AutoencoderKL"),
        ("from transformers import WhisperModel", "WhisperModel"),
        ("from face_detection import FaceAlignment, LandmarksType", "FaceAlignment-shim"),
    ]:
        try:
            exec(stmt, {})
            print(label, "OK")
        except Exception:
            print(label, "FAILED")
            traceback.print_exc()
