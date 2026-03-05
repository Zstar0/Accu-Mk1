# ============================================================
# Accu-Mk1 Backend — FastAPI + Uvicorn
# ============================================================
FROM python:3.12-slim

ARG APP_VERSION=0.0.0
ENV APP_VERSION=${APP_VERSION}

WORKDIR /app

# Install system dependencies for psycopg2-binary
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

EXPOSE 8012

# Run with uvicorn — 0.0.0.0 so Docker can route traffic in
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8012"]
