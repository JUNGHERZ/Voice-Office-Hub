"""
Admin-UI (Platzhalter) — spätere Ausbaustufe (Plan-Phase 12).

Geplant: Login (festes ADMIN_PASSWORD), Anrufliste (`requests`), Detail mit
Audio-Player (GridFS-Streaming, Range-Support), Transkript + Summary, Agents-CRUD.
Greift read-only auf dieselbe MongoDB zu (schreibend nur für `agents`).

Aktuell nur ein Health-Endpoint, damit der Container-Prozess sauber startet.
"""
import os

from fastapi import FastAPI

app = FastAPI(title="Voice Agent Admin", version="0.1.0")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "mongo_uri_set": str(bool(os.getenv("MONGO_URI")))}


@app.get("/")
def index() -> dict[str, str]:
    return {"message": "Admin-UI Platzhalter — Ausbau in Plan-Phase 12."}
