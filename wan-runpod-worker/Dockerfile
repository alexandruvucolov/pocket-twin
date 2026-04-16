FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y \
    git ffmpeg libgl1-mesa-glx libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Worker code
COPY handler.py .
COPY download_checkpoints.sh .
RUN chmod +x download_checkpoints.sh

COPY start.sh .
RUN chmod +x start.sh

CMD ["/app/start.sh"]
