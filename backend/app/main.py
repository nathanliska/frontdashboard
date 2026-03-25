from fastapi import FastAPI

app = FastAPI(title="FrontDashboard")


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}
