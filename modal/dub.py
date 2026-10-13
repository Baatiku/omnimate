"""Omnimate YouTube dubbing worker for Modal.

Deploy with:
    modal deploy modal/dub.py

Then set MODAL_DUB_URL in Omnimate `.env` to the printed URL.

What it does (no Gemini key needed here; translation and voice run in Node):
  1. POST /start {youtube_url | direct_url, src_lang} -> downloads the video,
     extracts audio, transcribes with timestamps (faster-whisper). Returns a
     job id immediately; heavy work runs in the background.
  2. GET /segments/{job} -> English segments with start/end times.
  3. POST /assemble/{job} (plan.json + per-block Hausa wav files) -> stretches
     each block to its exact time slot, joins them, and muxes onto the video
     without re-encoding the picture. Returns when queued.
  4. GET /status/{job} -> queued/downloading/transcribing/ready/assembling/done/failed.
  5. GET /download/{job}?file=dubbed.mp4|voiceover.wav -> the finished files.

All job files live on a persisted Modal Volume, so workers can be replaced
without losing videos.
"""

import io
import json
import re
import subprocess
import tempfile
import wave
from pathlib import Path

import modal
import numpy as np

app = modal.App("omnimate-dub")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "wget", "nodejs")
    .pip_install("fastapi==0.110.3", "python-multipart==0.0.9",
                 "yt-dlp[default]", "faster-whisper", "numpy", "scipy", "scikit-learn")
)

jobs = modal.Volume.from_name("omnimate-dub-jobs", create_if_missing=True)
JOBS_DIR = Path("/jobs")
WHISPER_MODEL = "base"


def _job_path(job_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{4,64}", job_id):
        raise ValueError("Bad job id.")
    return JOBS_DIR / job_id


def _write_status(job_id: str, status: str, progress: float = 0.0, detail: str = "") -> None:
    path = _job_path(job_id)
    path.mkdir(parents=True, exist_ok=True)
    payload = {"job_id": job_id, "status": status,
               "progress": progress, "detail": detail}
    (path / "status.json").write_text(json.dumps(payload))
    jobs.commit()


def _read_status(job_id: str) -> dict:
    try:
        return json.loads((_job_path(job_id) / "status.json").read_text())
    except Exception:
        return {"job_id": job_id, "status": "unknown", "progress": 0.0, "detail": ""}


def _read_wav_pcm(file_path: Path):
    with wave.open(str(file_path), "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        n_frames = wf.getnframes()
        data = wf.readframes(n_frames)
        if sampwidth == 2:
            arr = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        elif sampwidth == 4:
            arr = np.frombuffer(data, dtype=np.int32).astype(np.float32) / 2147483648.0
        else:
            arr = np.frombuffer(data, dtype=np.uint8).astype(np.float32) / 128.0 - 1.0
        if n_channels > 1:
            arr = arr.reshape(-1, n_channels).mean(axis=1)
        return arr, framerate


def compute_f0_autocorr(frame: np.ndarray, sr: int = 16000, min_f0: float = 70.0, max_f0: float = 380.0):
    """Estimate fundamental frequency (F0) pitch using normalized autocorrelation."""
    min_lag = int(sr / max_f0)
    max_lag = int(sr / min_f0)
    if len(frame) < max_lag:
        return 0.0, 0.0

    w = np.hamming(len(frame))
    sig = (frame - np.mean(frame)) * w
    var = float(np.dot(sig, sig))
    if var < 1e-6:
        return 0.0, 0.0

    corr = np.correlate(sig, sig, mode="full")
    corr = corr[len(sig) - 1 :]
    corr = corr / (corr[0] + 1e-9)

    search = corr[min_lag:max_lag]
    if len(search) == 0:
        return 0.0, 0.0

    peak_idx = int(np.argmax(search)) + min_lag
    peak_val = float(corr[peak_idx])
    if peak_val > 0.35:
        f0 = sr / float(peak_idx)
        return float(f0), peak_val
    return 0.0, peak_val


def extract_mel_filterbank(frame: np.ndarray, sr: int = 16000, n_mels: int = 16) -> np.ndarray:
    """Extract 16-band normalized log mel filterbank energies for vocal timbre representation."""
    fft_size = 512
    if len(frame) < fft_size:
        padded = np.zeros(fft_size, dtype=np.float32)
        padded[: len(frame)] = frame
        frame = padded
    else:
        frame = frame[:fft_size]

    spec = np.abs(np.fft.rfft(frame * np.hamming(fft_size))) ** 2
    freqs = np.fft.rfftfreq(fft_size, 1.0 / sr)

    low_freq = 150.0
    high_freq = min(7500.0, sr / 2.0)
    low_mel = 2595.0 * np.log10(1.0 + low_freq / 700.0)
    high_mel = 2595.0 * np.log10(1.0 + high_freq / 700.0)
    mel_points = np.linspace(low_mel, high_mel, n_mels + 2)
    hz_points = 700.0 * (10.0 ** (mel_points / 2595.0) - 1.0)

    fbank = np.zeros(n_mels, dtype=np.float32)
    for m in range(n_mels):
        left, center, right = hz_points[m], hz_points[m + 1], hz_points[m + 2]
        weights = np.zeros_like(freqs)
        mask_l = (freqs >= left) & (freqs <= center)
        if np.any(mask_l) and (center > left):
            weights[mask_l] = (freqs[mask_l] - left) / (center - left)
        mask_r = (freqs >= center) & (freqs <= right)
        if np.any(mask_r) and (right > center):
            weights[mask_r] = (right - freqs[mask_r]) / (right - center)
        fbank[m] = float(np.sum(spec * weights))
    log_fbank = np.log(fbank + 1e-6)
    norm = log_fbank - np.mean(log_fbank)
    std = float(np.std(norm))
    if std > 1e-4:
        norm = norm / std
    return norm


def extract_segment_features(samples: np.ndarray, sr: int = 16000) -> dict:
    """Extract acoustic pitch and vocal timbre vector across a spoken segment."""
    frame_len = int(sr * 0.030)  # 30ms analysis window
    hop_len = int(sr * 0.015)    # 15ms hop
    n_frames = max(1, (len(samples) - frame_len) // hop_len)

    f0_list = []
    fbanks = []
    for f in range(min(n_frames, 60)):
        start = f * hop_len
        end = start + frame_len
        frame = samples[start:end]
        if np.std(frame) < 0.005:  # skip background silence
            continue
        f0, _strength = compute_f0_autocorr(frame, sr)
        if f0 > 0:
            f0_list.append(f0)
        fbanks.append(extract_mel_filterbank(frame, sr))

    median_f0 = float(np.median(f0_list)) if f0_list else 145.0
    mean_fbank = np.mean(fbanks, axis=0) if fbanks else np.zeros(16, dtype=np.float32)

    # Human speech acoustic threshold: adult male pitch typically 85-155 Hz, adult female 165-270 Hz
    gender = "Female" if median_f0 >= 165.0 else "Male"

    # Normalized composite feature: timbre (16) + weighted pitch deviation (1)
    pitch_feat = (median_f0 - 150.0) / 60.0
    feature_vec = np.concatenate([mean_fbank, [pitch_feat * 2.0]])
    return {
        "feature_vec": feature_vec,
        "median_f0": median_f0,
        "gender": gender,
    }


def cluster_speakers(segment_feats: list) -> tuple[list[int], int]:
    """Dynamically cluster segments into distinct speaker identities using Agglomerative Clustering."""
    n = len(segment_feats)
    if n == 0:
        return [], 0
    if n == 1:
        return [0], 1

    from sklearn.cluster import AgglomerativeClustering
    from sklearn.metrics import silhouette_score
    from scipy.spatial.distance import pdist

    X = np.array([s["feature_vec"] for s in segment_feats])
    dists = pdist(X, metric="euclidean")
    max_d = float(np.max(dists)) if len(dists) > 0 else 0.0
    mean_d = float(np.mean(dists)) if len(dists) > 0 else 0.0

    # Single speaker check: if audio is acoustically uniform, keep 1 speaker
    if max_d < 2.0 or mean_d < 1.2:
        return [0] * n, 1

    best_k = 1
    best_score = 0.25  # minimum silhouette threshold to establish distinct speakers
    best_labels = [0] * n

    for k in range(2, min(7, n)):
        model = AgglomerativeClustering(n_clusters=k, metric="euclidean", linkage="ward")
        labels = model.fit_predict(X)
        try:
            score = float(silhouette_score(X, labels))
            if score > best_score:
                best_score = score
                best_k = k
                best_labels = list(labels)
        except Exception:
            pass

    return [int(lbl) for lbl in best_labels], best_k


def do_source(path: Path, youtube_url: str, direct_url: str, src_lang: str, direct_source: bool = False) -> tuple[list, dict]:
    """Download or ingest video, extract audio, separate background M&E, and transcribe with acoustic speaker diarization."""
    source = path / "source.mp4"
    if not direct_source:
        if youtube_url:
            cmd = ["yt-dlp", "-f", "bv*[height<=720]+ba/b[height<=720]/b",
                   "--extractor-args", "youtube:player_client=android,ios,web",
                   "--merge-output-format", "mp4", "-o", str(source), youtube_url]
        else:
            cmd = ["yt-dlp", "-f", "b", "--merge-output-format", "mp4",
                   "--extractor-args", "generic:impersonate=chrome",
                   "-o", str(source), direct_url]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        if not source.exists() or source.stat().st_size < 10_000:
            if youtube_url:
                # Fallback to direct progressive stream which does not trigger adaptive stream challenges
                cmd_fallback = ["yt-dlp", "-f", "18/22/b",
                                "--extractor-args", "youtube:player_client=android,web",
                                "-o", str(source), youtube_url]
                proc = subprocess.run(cmd_fallback, capture_output=True, text=True, timeout=1800)
            if not source.exists() or source.stat().st_size < 10_000:
                raise RuntimeError(f"Download failed: {((proc.stderr or '') + (proc.stdout or ''))[-800:]}")

    # Extract clean mono 16kHz speech track for Whisper
    audio = path / "audio.wav"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(source),
                    "-ac", "1", "-ar", "16000", str(audio)], check=True, timeout=600)

    # Extract background M&E (Music & Ambient Effects) bed
    # Uses center-vocal cancellation for stereo tracks and band-reject for mono
    bg_audio = path / "background.wav"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(source),
             "-af", "stereotools=mlev=0.1:slev=1.0,highpass=f=70,lowpass=f=14000",
             "-ar", "24000", "-ac", "2", str(bg_audio)],
            check=True, timeout=300)
    except Exception:
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-i", str(source),
                 "-af", "volume=0.3,equalizer=f=1200:width_type=h:width=1800:g=-12",
                 "-ar", "24000", "-ac", "1", str(bg_audio)],
                check=True, timeout=300)
        except Exception:
            pass

    from faster_whisper import WhisperModel

    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    lang = None if src_lang == "auto" else src_lang
    raw_segments, _info = model.transcribe(str(audio), language=lang, vad_filter=True, word_timestamps=True)

    # Read audio PCM for acoustic feature extraction and diarization
    audio_arr, audio_sr = _read_wav_pcm(audio)

    parsed_turns = []
    seg_feats = []

    for s in raw_segments:
        text = s.text.strip()
        if not text:
            continue
        words = []
        if getattr(s, "words", None):
            words = [{"word": w.word, "start": round(w.start, 2), "end": round(w.end, 2)} for w in s.words]

        start_samp = int(max(0.0, s.start) * audio_sr)
        end_samp = min(len(audio_arr), int(max(s.start + 0.1, s.end) * audio_sr))
        seg_samples = audio_arr[start_samp:end_samp]
        feat = extract_segment_features(seg_samples, audio_sr)
        seg_feats.append(feat)

        parsed_turns.append({
            "i": len(parsed_turns),
            "start": round(s.start, 2),
            "end": round(s.end, 2),
            "text": text,
            "words": words,
            "pitch_hz": round(feat["median_f0"], 1),
            "gender": feat["gender"],
        })

    if not parsed_turns:
        raise RuntimeError("No speech found in this video.")

    labels, _num_speakers = cluster_speakers(seg_feats)

    # Assign clustered speaker labels to segments
    segments = []
    for idx, turn in enumerate(parsed_turns):
        spk_idx = labels[idx] if idx < len(labels) else 0
        turn["speaker"] = f"speaker_{spk_idx}"
        segments.append(turn)

    # Compute speaker metadata (gender, median pitch, count, representative audio sample)
    speakers_meta = {}
    for spk_idx in sorted(set(labels)):
        spk_id = f"speaker_{spk_idx}"
        spk_segs = [s for s in segments if s["speaker"] == spk_id]
        pitches = [s["pitch_hz"] for s in spk_segs if s.get("pitch_hz", 0) > 0]
        med_pitch = float(np.median(pitches)) if pitches else 140.0
        gender = "Female" if med_pitch >= 165.0 else "Male"
        # Extract a clean scene keyframe centered on the speaker's longest utterance
        mid_sec = max(0.0, round((sample_seg["start"] + sample_seg["end"]) / 2.0, 2))
        frame_file = f"frame_{spk_id}.jpg"
        frame_path = path / frame_file
        try:
            subprocess.run([
                "ffmpeg", "-y", "-v", "error", "-ss", f"{mid_sec:.2f}",
                "-i", str(source), "-vframes", "1", "-q:v", "2",
                str(frame_path)
            ], timeout=30)
        except Exception:
            pass

        speakers_meta[spk_id] = {
            "id": spk_id,
            "gender": gender,
            "pitch_hz": round(med_pitch, 1),
            "sample_seg_i": sample_seg["i"],
            "count": len(spk_segs),
            "total_sec": round(sum(s["end"] - s["start"] for s in spk_segs), 1),
            "keyframe_sec": mid_sec,
            "has_frame": frame_path.exists(),
        }

    (path / "segments.json").write_text(json.dumps({"segments": segments, "speakers": speakers_meta}, ensure_ascii=False))
    jobs.commit()
    return segments, speakers_meta


def _video_duration_sec(video: Path) -> float:
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(video)],
            capture_output=True, text=True, timeout=60)
        return max(0.0, float((proc.stdout or "").strip() or 0.0))
    except Exception:
        return 0.0


def do_assemble(path: Path, plan: dict) -> None:
    """Place each line at its exact mark, eliminate scene volume jumping with
    dynaudnorm and loudnorm (-16 LUFS), sidechain duck background music,
    and mux onto the video.
    """
    placements = plan.get("placements", [])
    if not placements:
        raise RuntimeError("Empty dub plan.")
    total = _video_duration_sec(path / "source.mp4")
    if total <= 0:
        total = max(p.get("at_ms", 0) / 1000.0 + 5.0 for p in placements)

    sr = 24000
    total_samples = int(np.ceil(total * sr))
    master_dialogue = np.zeros(total_samples, dtype=np.float32)

    with tempfile.TemporaryDirectory() as tmp:
        for p in placements:
            src = path / "blocks" / p["file"]
            if not src.exists():
                raise RuntimeError(f"Missing voice file {p['file']}.")
            tempo = min(2.0, max(0.5, float(p.get("tempo", 1.0))))
            at_ms = max(0, int(p.get("at_ms", 0)))
            start_sample = int(at_ms * sr / 1000)

            if abs(tempo - 1.0) > 0.01:
                stretched = Path(tmp) / f"str_{int(p['i']):06d}.wav"
                subprocess.run(
                    ["ffmpeg", "-y", "-v", "error", "-i", str(src),
                     "-filter:a", f"atempo={tempo:.4f}",
                     "-ar", str(sr), "-ac", "1", str(stretched)],
                    check=True, timeout=120)
                wav_file = stretched
            else:
                wav_file = src

            arr, rate = _read_wav_pcm(wav_file)
            if rate != sr:
                resampled = Path(tmp) / f"res_{int(p['i']):06d}.wav"
                subprocess.run(
                    ["ffmpeg", "-y", "-v", "error", "-i", str(wav_file),
                     "-ar", str(sr), "-ac", "1", str(resampled)],
                    check=True, timeout=120)
                arr, _ = _read_wav_pcm(resampled)

            end_sample = min(total_samples, start_sample + len(arr))
            seg_len = end_sample - start_sample
            if seg_len > 0:
                master_dialogue[start_sample:end_sample] += arr[:seg_len]

        # Soft peak limiting
        peak = np.max(np.abs(master_dialogue))
        if peak > 0.95:
            master_dialogue = np.tanh(master_dialogue / peak) * 0.95

        # Write raw dialogue PCM
        raw_dialogue_path = Path(tmp) / "dialogue_raw.wav"
        int16_pcm = np.clip(master_dialogue * 32767.0, -32768, 32767).astype(np.int16)
        with wave.open(str(raw_dialogue_path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(int16_pcm.tobytes())

        # Dynamic speech leveling + broadcast EBU R128 loudness normalization
        dialogue_master = Path(tmp) / "dialogue_master.wav"
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(raw_dialogue_path),
             "-filter:a", "dynaudnorm=f=250:g=15:p=0.95:m=8.0,loudnorm=I=-16:TP=-1.5:LRA=11",
             "-ar", str(sr), "-ac", "1", str(dialogue_master)],
            check=True, timeout=300)

        # Mix with background M&E bed if present
        bg_track = path / "background.wav"
        bg_volume = float(plan.get("bg_volume", 0.25))
        ducking = bool(plan.get("ducking", True))
        voiceover = path / "voiceover.wav"

        if bg_track.exists() and bg_volume > 0.01:
            if ducking:
                duck_filter = (
                    f"[1:a]volume={bg_volume:.2f}[bg];"
                    f"[bg][0:a]sidechaincompress=threshold=0.08:ratio=5:attack=100:release=350[ducked_bg];"
                    f"[0:a][ducked_bg]amix=inputs=2:normalize=0"
                )
                if total > 0:
                    duck_filter += f",atrim=0:{total:.2f}"
                subprocess.run(
                    ["ffmpeg", "-y", "-v", "error",
                     "-i", str(dialogue_master), "-i", str(bg_track),
                     "-filter_complex", duck_filter,
                     "-c:a", "pcm_s16le", str(voiceover)],
                    check=True, timeout=600)
            else:
                subprocess.run(
                    ["ffmpeg", "-y", "-v", "error",
                     "-i", str(dialogue_master), "-i", str(bg_track),
                     "-filter_complex", f"[1:a]volume={bg_volume:.2f}[bg];[0:a][bg]amix=inputs=2:normalize=0,atrim=0:{total:.2f}",
                     "-c:a", "pcm_s16le", str(voiceover)],
                    check=True, timeout=600)
        else:
            if total > 0:
                subprocess.run(
                    ["ffmpeg", "-y", "-v", "error", "-i", str(dialogue_master),
                     "-filter:a", f"atrim=0:{total:.2f}",
                     "-c:a", "pcm_s16le", str(voiceover)],
                    check=True, timeout=300)
            else:
                subprocess.run(
                    ["ffmpeg", "-y", "-v", "error", "-i", str(dialogue_master),
                     "-c:a", "pcm_s16le", str(voiceover)],
                    check=True, timeout=300)

        # Mux onto video
        dubbed = path / "dubbed.mp4"
        mux = ["ffmpeg", "-y", "-v", "error", "-i", str(path / "source.mp4"),
               "-i", str(voiceover), "-map", "0:v", "-map", "1:a",
               "-c:v", "copy", "-c:a", "aac", "-b:a", "192k"]
        if total > 0:
            mux += ["-t", f"{total:.2f}"]
        mux.append(str(dubbed))
        subprocess.run(mux, check=True, timeout=1200)

    jobs.commit()


@app.function(image=image, timeout=3600, volumes={"/jobs": jobs})
@modal.asgi_app()
def dub_app():
    # Built inside the container so local/remote package versions can never
    # confuse upload parsing (see presenter.py for the full story).
    # Everything runs inline in the request (no background spawns), so a job
    # can never sit in a queue nobody serves.
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, Response, FileResponse

    web = FastAPI()

    @web.post("/start")
    async def start(request: Request):
        form = await request.form()
        youtube_url = str(form.get("youtube_url") or "").strip()
        direct_url = str(form.get("direct_url") or "").strip()
        src_lang = str(form.get("src_lang") or "en").strip() or "en"
        video_upload = form.get("video_file")

        if not youtube_url and not direct_url and not video_upload:
            return JSONResponse({"error": "Give a YouTube link, a direct video link, or upload a video file."},
                                status_code=400)
        if youtube_url and not re.match(r"^https?://", youtube_url):
            return JSONResponse({"error": "That YouTube link looks invalid."},
                                status_code=400)
        if direct_url and not re.match(r"^https?://", direct_url):
            return JSONResponse({"error": "That file link looks invalid."},
                                status_code=400)
        import uuid

        job_id = f"dub_{uuid.uuid4().hex[:12]}"
        path = _job_path(job_id)
        path.mkdir(parents=True, exist_ok=True)
        try:
            if video_upload and hasattr(video_upload, "read"):
                source = path / "source.mp4"
                source.write_bytes(await video_upload.read())
                segments, speakers_meta = do_source(path, "", "", src_lang, direct_source=True)
            else:
                segments, speakers_meta = do_source(path, youtube_url, direct_url, src_lang)
        except Exception as error:
            return JSONResponse({"error": str(error)[:500]}, status_code=500)
        return {"job_id": job_id, "segments": segments, "speakers": speakers_meta,
                "video_duration": _video_duration_sec(path / "source.mp4")}

    @web.get("/segments/{job_id}")
    async def segments(job_id: str):
        try:
            raw = json.loads((_job_path(job_id) / "segments.json").read_text())
            if isinstance(raw, dict) and "segments" in raw:
                segs = raw["segments"]
                speakers = raw.get("speakers", {})
            else:
                segs = raw
                speakers = {}
        except Exception:
            return JSONResponse({"error": "Transcript not found."}, status_code=500)
        return {"ready": True, "segments": segs, "speakers": speakers,
                "video_duration": _video_duration_sec(_job_path(job_id) / "source.mp4")}

    @web.get("/sample/{job_id}/{segment_i}")
    async def sample(job_id: str, segment_i: int):
        path = _job_path(job_id)
        audio_path = path / "audio.wav"
        segs_path = path / "segments.json"
        if not audio_path.exists() or not segs_path.exists():
            return Response(content="Audio not found", status_code=404)
        try:
            raw = json.loads(segs_path.read_text())
            segs = raw["segments"] if isinstance(raw, dict) and "segments" in raw else raw
            if segment_i < 0 or segment_i >= len(segs):
                return Response(content="Segment index out of range", status_code=404)
            seg = segs[segment_i]
            start_sec = max(0.0, float(seg["start"]))
            end_sec = min(start_sec + 4.0, float(seg["end"]))
            arr, sr = _read_wav_pcm(audio_path)
            start_samp = int(start_sec * sr)
            end_samp = min(len(arr), int(end_sec * sr))
            slice_arr = arr[start_samp:end_samp]
            if len(slice_arr) == 0:
                return Response(content="Empty audio slice", status_code=404)
            buf = io.BytesIO()
            int16_pcm = np.clip(slice_arr * 32767.0, -32768, 32767).astype(np.int16)
            with wave.open(buf, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sr)
                wf.writeframes(int16_pcm.tobytes())
            return Response(content=buf.getvalue(), media_type="audio/wav")
        except Exception as e:
            return Response(content=str(e), status_code=500)

    @web.get("/frame/{job_id}/{speaker_id}")
    async def frame(job_id: str, speaker_id: str):
        path = _job_path(job_id)
        safe_spk = re.sub(r"[^A-Za-z0-9_-]", "", speaker_id)
        target = path / f"frame_{safe_spk}.jpg"
        if not target.exists():
            return Response(content="Frame not found", status_code=404)
        return FileResponse(str(target), media_type="image/jpeg")

    @web.post("/assemble/{job_id}")
    async def assemble(job_id: str, request: Request):
        form = await request.form()
        plan = str(form.get("plan") or "")
        if not plan:
            return JSONResponse({"error": "Missing translation plan."}, status_code=400)
        try:
            plan_obj = json.loads(plan)
        except Exception:
            return JSONResponse({"error": "Broken translation plan."}, status_code=400)
        path = _job_path(job_id)
        if not (path / "source.mp4").exists():
            return JSONResponse({"error": "Unknown dub job."}, status_code=404)
        dest = path / "blocks"
        dest.mkdir(parents=True, exist_ok=True)
        saved = 0
        for _key, upload in form.multi_items():
            filename = getattr(upload, "filename", "") or ""
            if not filename.lower().endswith(".wav"):
                continue
            safe = re.sub(r"[^A-Za-z0-9_.-]", "_", filename.split("/")[-1])[:80]
            (dest / safe).write_bytes(await upload.read())
            saved += 1
        if not saved:
            return JSONResponse({"error": "No voice files arrived."}, status_code=400)
        try:
            do_assemble(path, plan_obj)
        except Exception as error:
            return JSONResponse({"error": str(error)[:500]}, status_code=500)
        return {"ok": True, "files": saved}

    @web.get("/status/{job_id}")
    async def status(job_id: str):
        # Derived from real files, so it can never lie about the stage.
        path = _job_path(job_id)
        if (path / "dubbed.mp4").exists():
            return {"job_id": job_id, "status": "done", "detail": "Hausa video ready."}
        if (path / "segments.json").exists():
            return {"job_id": job_id, "status": "transcribed",
                    "detail": "Heard every word. Translating next."}
        if (path / "source.mp4").exists():
            return {"job_id": job_id, "status": "downloaded",
                    "detail": "Video in hand. Hearing the words next."}
        if path.exists():
            return {"job_id": job_id, "status": "starting",
                    "detail": "Warming up the engine (first run takes minutes)."}
        return {"job_id": job_id, "status": "unknown", "detail": "No such job."}

    @web.get("/download/{job_id}")
    async def download(job_id: str, request: Request):
        name = request.query_params.get("file", "dubbed.mp4")
        allowed = {"dubbed.mp4": "video/mp4", "voiceover.wav": "audio/wav"}
        if name not in allowed:
            return Response(content="Unknown file.", status_code=400)
        target = _job_path(job_id) / name
        if not target.exists():
            return Response(content="Not ready yet.", status_code=404)
        return FileResponse(str(target), media_type=allowed[name], filename=name)

    return web
