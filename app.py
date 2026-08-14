@app.get("/extract-test")
def extract_test(url: str):
    try:
        opts = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "skip_download": True,
            "format": "best[acodec!=none][vcodec!=none]/best",
        }

        with yt_dlp.YoutubeDL(opts) as ydl:
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
