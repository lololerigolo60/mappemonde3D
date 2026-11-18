FROM node:20-alpine

WORKDIR /app

# Copier uniquement les fichiers nécessaires
COPY index.html style.css globe.js ui.js extras.js server.js ./
COPY countries-data.json ./
COPY data/ ./data/

# Créer le dossier cache
RUN mkdir -p cache

# Port
EXPOSE 3456

# Lancer le serveur
CMD ["node", "server.js"]
