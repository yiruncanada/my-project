# 资产管家 - 多架构 Docker 镜像（支持 x86_64 / arm64 / armv7）
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# opencv-python 依赖的系统库（否则 import cv2 报错）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# 先装依赖（利用层缓存）
COPY requirements.txt .
RUN pip install -r requirements.txt gunicorn

# 复制应用代码
COPY app.py .
COPY templates/ templates/
COPY static/ static/

# 数据库放在 /data 卷，便于持久化
ENV DB_PATH=/data/database.db
VOLUME /data
EXPOSE 5000

# 单 worker：OCR 模型只加载一份，节省内存（路由器内存有限）
CMD ["gunicorn", "--workers", "1", "--preload", "--timeout", "120", "--bind", "0.0.0.0:5000", "app:app"]
