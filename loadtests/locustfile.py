"""
SurveyOps Locust Load Test Suite.

Simulates concurrent enterprise traffic across:
- Field enumerators submitting responses & idempotent sync batches
- Analysts querying live SQL analytics, response registry pagination, and quality queues
- Admins inspecting surveys and pipeline status

Run headlessly:
  locust -f loadtests/locustfile.py --headless -u 25 -r 5 -t 30s --host http://localhost:8070
"""
import random
import uuid
from datetime import datetime, timezone

from locust import HttpUser, between, task


DISTRICTS = ["Metro Central", "North Metro", "East River", "South Harbor", "West Highlands"]
MODES = ["municipal_bus", "light_rail", "paratransit", "bicycle_walk", "private_vehicle"]


class FieldAgentUser(HttpUser):
    weight = 3
    wait_time = between(0.4, 1.2)

    def on_start(self):
        res = self.client.post(
            "/api/v1/auth/login",
            json={"email": "agent@surveyops.org", "password": "AgentPass123!"},
            name="/api/v1/auth/login [agent]",
        )
        if res.status_code == 200:
            self.token = res.json()["access_token"]
            self.headers = {"Authorization": f"Bearer {self.token}"}
            asgns = self.client.get(
                "/api/v1/assignments/my-field-assignments",
                headers=self.headers,
                name="/api/v1/assignments/my-field-assignments",
            )
            items = asgns.json().get("items", []) if asgns.status_code == 200 else []
            self.assignment = next((a for a in items if a.get("survey_code") == "CIV-2026-TRN"), items[0] if items else None)
        else:
            self.headers = {}
            self.assignment = None

    @task(4)
    def submit_single_field_response(self):
        if not self.assignment:
            return
        mode = random.choice(MODES)
        answers = {
            "primary_mode": mode,
            "weekly_transit_trips": random.randint(2, 16),
            "step_free_access_needed": False,
            "reliability_rating": random.randint(2, 5),
            "safety_rating": random.randint(2, 5),
            "affordability_rating": random.randint(2, 5),
        }
        if mode in ("municipal_bus", "light_rail", "paratransit"):
            answers["avg_wait_minutes"] = random.randint(5, 25)

        self.client.post(
            "/api/v1/responses",
            headers=self.headers,
            json={
                "client_submission_id": f"locust-{uuid.uuid4().hex[:14]}",
                "survey_id": self.assignment["survey_id"],
                "survey_version_id": self.assignment["survey_version_id"],
                "assignment_id": self.assignment["id"],
                "answers": answers,
                "consent_given": True,
                "location_consent_given": False,
                "district": random.choice(DISTRICTS),
                "submitted_at": datetime.now(timezone.utc).isoformat(),
                "duration_seconds": random.randint(120, 260),
                "source_channel": "mobile_online",
            },
            name="/api/v1/responses [POST single]",
        )

    @task(1)
    def submit_offline_sync_batch(self):
        if not self.assignment:
            return
        batch_items = []
        for _ in range(5):
            batch_items.append({
                "client_submission_id": f"locust-b-{uuid.uuid4().hex[:12]}",
                "survey_id": self.assignment["survey_id"],
                "survey_version_id": self.assignment["survey_version_id"],
                "answers": {
                    "primary_mode": "light_rail",
                    "weekly_transit_trips": random.randint(4, 14),
                    "avg_wait_minutes": random.randint(6, 20),
                    "step_free_access_needed": False,
                    "reliability_rating": 4,
                    "safety_rating": 4,
                    "affordability_rating": 3,
                },
                "consent_given": True,
                "location_consent_given": False,
                "district": random.choice(DISTRICTS),
                "duration_seconds": random.randint(140, 240),
                "source_channel": "mobile_offline",
            })
        self.client.post(
            "/api/v1/responses/batch",
            headers=self.headers,
            json={"items": batch_items},
            name="/api/v1/responses/batch [POST 5 items]",
        )


class AnalystOperationsUser(HttpUser):
    weight = 2
    wait_time = between(0.5, 1.5)

    def on_start(self):
        res = self.client.post(
            "/api/v1/auth/login",
            json={"email": "analyst@surveyops.org", "password": "AnalystPass123!"},
            name="/api/v1/auth/login [analyst]",
        )
        if res.status_code == 200:
            self.headers = {"Authorization": f"Bearer {res.json()['access_token']}"}
            s_res = self.client.get("/api/v1/surveys", headers=self.headers, name="/api/v1/surveys")
            items = s_res.json().get("items", []) if s_res.status_code == 200 else []
            trn = next((s for s in items if s.get("code") == "CIV-2026-TRN"), items[0] if items else None)
            self.survey_id = trn["id"] if trn else None
        else:
            self.headers = {}
            self.survey_id = None

    @task(3)
    def read_analytics_overview(self):
        params = {"survey_id": self.survey_id, "days": 30} if self.survey_id else {"days": 30}
        self.client.get("/api/v1/analytics/overview", params=params, headers=self.headers, name="/api/v1/analytics/overview")

    @task(2)
    def read_quality_queue(self):
        self.client.get(
            "/api/v1/quality/issues",
            params={"status": "open", "page": 1, "page_size": 20},
            headers=self.headers,
            name="/api/v1/quality/issues",
        )

    @task(2)
    def read_responses_paginated(self):
        self.client.get(
            "/api/v1/responses",
            params={"page": random.randint(1, 10), "page_size": 25},
            headers=self.headers,
            name="/api/v1/responses [paginated]",
        )

    @task(1)
    def read_pipeline_summary(self):
        self.client.get("/api/v1/pipeline/summary", headers=self.headers, name="/api/v1/pipeline/summary")
