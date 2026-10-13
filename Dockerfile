FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm install --omit=dev
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
