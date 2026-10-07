FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY . .
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787
CMD ["npm", "start"]
