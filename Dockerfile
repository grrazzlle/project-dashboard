FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
VOLUME /app/data
EXPOSE 3000
CMD ["npm", "start"]
