FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pil \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY README.md ./

ENV NODE_ENV=production
ENV PORT=3000
ENV PYTHON_EXE=python3

EXPOSE 3000

CMD ["npm", "start"]
