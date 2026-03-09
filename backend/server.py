from fastapi import FastAPI, APIRouter
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, ConfigDict
from typing import List
from pathlib import Path
from datetime import datetime, timezone
import os
import uuid
import logging

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

app = FastAPI()
api_router = APIRouter(prefix="/api")

# -------------------------
# Existing health endpoints
# -------------------------

class StatusCheck(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class StatusCheckCreate(BaseModel):
    client_name: str

@api_router.get("/")
async def root():
    return {"message": "CivicNest API running"}

@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_dict = input.model_dump()
    status_obj = StatusCheck(**status_dict)

    doc = status_obj.model_dump()
    doc["timestamp"] = doc["timestamp"].isoformat()

    await db.status_checks.insert_one(doc)
    return status_obj

@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    status_checks = await db.status_checks.find({}, {"_id": 0}).to_list(1000)

    for check in status_checks:
        if isinstance(check["timestamp"], str):
            check["timestamp"] = datetime.fromisoformat(check["timestamp"])

    return status_checks


# -------------------------
# CivicNest Chat Endpoint
# -------------------------

class ChatRequest(BaseModel):
    text: str
    area: str | None = None
    time_context: str | None = None

@app.post("/query")
async def civic_chat(req: ChatRequest):

    incident = {
        "incident_id": str(uuid.uuid4()),
        "issue_category": "civic_issue",
        "reported_at": datetime.utcnow().isoformat(),
        "zone": req.area or "Unknown",
        "status": "new",
        "priority": "medium",
        "recurrence_score": 0.4,
        "description": req.text
    }

    await db.incidents.insert_one(incident)

    return {
        "answer": "Your report has been logged and sent to the city operations queue.",
        "confidence": 0.82,
        "insights": ["Resident report successfully captured"],
        "recommended_actions": ["City worker will review the incident"],
        "evidence": [{"dataset": "Resident report intake", "note": "Direct resident submission"}],
        "assumptions": [],
        "caveats": [],
        "ops": {
            "priority": "medium",
            "status": "new",
            "recurrence_score": 0.4,
            "incident_id": incident["incident_id"]
        }
    }


# -------------------------
# Operations Queue
# -------------------------

@app.get("/ops/queue")
async def get_queue():

    incidents = await db.incidents.find({}, {"_id": 0}).to_list(100)

    return {
        "items": incidents
    }


# -------------------------
# Hotspots
# -------------------------

@app.get("/ops/hotspots")
async def hotspots():

    incidents = await db.incidents.find({}, {"_id": 0}).to_list(200)

    zones = {}

    for i in incidents:
        z = i.get("zone", "Unknown")

        if z not in zones:
            zones[z] = {"zone": z, "open_count": 0, "max_recurrence_score": 0}

        zones[z]["open_count"] += 1
        zones[z]["max_recurrence_score"] = max(
            zones[z]["max_recurrence_score"],
            i.get("recurrence_score", 0)
        )

    return {"hotspots": list(zones.values())}


# -------------------------
# Insights
# -------------------------

@app.get("/insight")
async def insights():

    total = await db.incidents.count_documents({})
    resolved = await db.incidents.count_documents({"status": "resolved"})

    return {
        "summary": {
            "total_incidents": total,
            "resolved_this_week": resolved,
            "avg_resolution_time": "2.3 days",
            "high_priority_count": 0
        }
    }


# -------------------------
# Escalations
# -------------------------

class EscalationRequest(BaseModel):
    incident_id: str
    reason: str

@app.post("/ops/escalations")
async def escalate(req: EscalationRequest):

    escalation = {
        "escalation_id": str(uuid.uuid4()),
        "incident_id": req.incident_id,
        "reason": req.reason,
        "created_at": datetime.utcnow().isoformat(),
        "status": "active"
    }

    await db.escalations.insert_one(escalation)

    return escalation


# -------------------------
# Incident status update
# -------------------------

@app.patch("/ops/incidents/{incident_id}/status")
async def update_status(incident_id: str, status: dict):

    await db.incidents.update_one(
        {"incident_id": incident_id},
        {"$set": {"status": status.get("status", "assigned")}}
    )

    return {"incident_id": incident_id, "status": status.get("status")}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
