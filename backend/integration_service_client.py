"""Thin HTTP client wrapping the integration-service internal API.

Centralizes the three endpoints Accu-Mk1 calls into integration-service:
  - relay_peptide_request_status  (Task 13)
  - issue_coupon                  (Task 14)
  - clone_senaite_service         (Task 14)

Auth is a shared secret passed via the X-Service-Token header. Base URL and
token come from environment variables — the client fails fast at construction
if either is missing, so misconfiguration surfaces at job start rather than on
the first POST.
"""
import os
import requests


class IntegrationServiceClient:
    def __init__(self):
        self.base = os.environ["INTEGRATION_SERVICE_URL"].rstrip("/")
        self.token = os.environ["INTEGRATION_SERVICE_TOKEN"]

    def _headers(self) -> dict:
        return {"X-Service-Token": self.token, "Content-Type": "application/json"}

    def relay_peptide_request_status(self, payload: dict) -> dict:
        resp = requests.post(
            f"{self.base}/v1/internal/wp/peptide-request-status",
            headers=self._headers(), json=payload, timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    def issue_coupon(self, payload: dict) -> dict:
        resp = requests.post(
            f"{self.base}/v1/internal/wp/coupons/single-use",
            headers=self._headers(), json=payload, timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    def clone_senaite_service(self, payload: dict) -> dict:
        resp = requests.post(
            f"{self.base}/v1/internal/senaite/services/clone",
            headers=self._headers(), json=payload, timeout=30,
        )
        resp.raise_for_status()
        return resp.json()
