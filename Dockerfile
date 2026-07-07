FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=4600 DATA_DIR=/var/rail/data OUT_DIR=/var/rail/outputs
EXPOSE 4600
CMD ["node", "server.js"]
