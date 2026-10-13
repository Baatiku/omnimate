# Omnimate Realistic Presenter

One photo plus one script becomes a talking presenter video.

## Flow

1. Browser sends a JPG/PNG photo and script to `POST /api/presenters`.
2. Node saves the photo and asks Gemini Live for narration (`audio.wav`).
3. Node sends photo + audio to the Modal GPU worker.
4. Modal runs MuseTalk 1.5 lip sync plus GFPGAN face sharpening on an A100.
5. Node saves `presenter.mp4` and the browser previews it.

Voice and video save separately, so a failed video render keeps the voice
and can be retried without paying for voice twice.

## Deploy the Modal worker

```bash
pip install modal
modal setup
modal deploy modal/presenter.py
```

Copy the printed HTTPS URL into `.env`:

```env
MODAL_PRESENTER_URL=https://your-user--omnimate-presenter-generate.modal.run
```

High quality uses A100 40GB and takes a few minutes on first cold start
(weights download once). Fast quality is a cheaper draft.

## Quality notes

- Front-facing portrait, eyes and mouth visible, under 10 MB.
- Short sentences speak cleaner than one long paragraph.
- 30 to 90 seconds is the sweet spot per job.
- Mark AI-generated content wherever you publish (YouTube requires it).
- Only animate photos you own or have permission to use.
