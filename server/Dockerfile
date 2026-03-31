FROM node:20-slim

# Install Playwright system dependencies
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libatspi2.0-0 libwayland-client0 \
    fonts-noto-cjk fonts-freefont-ttf \
    tar gzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install && npx playwright install chromium

# Copy scripts
COPY server.js ./
COPY scripts/ ./scripts/

EXPOSE 8080
CMD ["node", "server.js"]
