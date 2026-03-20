FROM node:24-slim

RUN apt-get update && apt-get install -y \
    ffmpeg fontconfig sed wget ca-certificates \
    --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY src/package.json ./
RUN npm install

COPY src/ /app/

EXPOSE 3000

CMD ["node", "index.js"]
