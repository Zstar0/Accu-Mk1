# ============================================================
# Accu-Mk1 Backend — FastAPI + Uvicorn
# ============================================================
FROM python:3.12-slim

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

# Create data directory for SQLite persistence
RUN mkdir -p /app/data

EXPOSE 8012

# Run with uvicorn — 0.0.0.0 so Docker can route traffic in
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8012"]
