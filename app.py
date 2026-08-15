from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import yt_dlp

app = FastAPI(title="Butterfly MediaServer")


class ExtractRequest(BaseModel):
    url: str


def get_opts():
    return {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "format": "best[acodec!=none][vcodec!=none]/best",
        "extractor_args": {
            "youtubepot-bgutilhttp": {
                "base_url": "https://bgutil-ytdlp-pot-provider-hukw.onrender.com"
            }
        },
    }


@app.get("/")
def root():
    return {"status": "ok", "service": "Butterfly MediaServer"}


@app.get("/extract-test")
def extract_test(url: str):
    try:
        with yt_dlp.YoutubeDL(get_opts()) as ydl:
            info = ydl.extract_info(url, download=False)

        return {
            "success": True,
            "id": info.get("id"),
            "title": info.get("title"),
            "thumbnail": info.get("thumbnail"),
            "duration": info.get("duration"),
            "url": info.get("url"),
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/extract")
def extract(req: ExtractRequest):
    try:
        with yt_dlp.YoutubeDL(get_opts()) as ydl:
            info = ydl.extract_info(req.url, download=False)

        return {
            "success": True,
            "id": info.get("id"),
            "title": info.get("title"),
            "thumbnail": info.get("thumbnail"),
            "duration": info.get("duration"),
            "url": info.get("url"),
            "ext": info.get("ext"),
            "width": info.get("width"),
            "height": info.get("height"),
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
