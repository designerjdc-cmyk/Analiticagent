# 📊 InstaMetrics — Instagram Analytics Dashboard

Dashboard multi-cuenta para trackear métricas reales de Instagram usando la API oficial de Meta.

![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![License](https://img.shields.io/badge/license-MIT-blue)

## ✨ Funcionalidades

- **Multi-cuenta**: Conecta todas las cuentas que quieras
- **Métricas reales**: Seguidores, alcance, impresiones, engagement
- **Galería de posts**: Ve todos tus posts con likes y comentarios
- **Demografía**: Datos de audiencia (edad, género, ubicación)
- **Comparación**: Tabla comparativa entre todas tus cuentas
- **Auto-refresh de tokens**: Aviso y renovación de tokens antes de que expiren

---

## 🚀 Despliegue rápido (Render.com — GRATIS)

### Paso 1: Crear la app en Meta

1. Ve a [developers.facebook.com](https://developers.facebook.com) y crea una cuenta
2. Haz clic en **"Create App"**
3. Selecciona **"Other"** → **"Business"**
4. Ponle un nombre (ej: "InstaMetrics") y crea la app
5. En el dashboard de tu app, busca **"Instagram"** en productos y haz clic en **"Set Up"**
6. Ve a **App Settings → Basic** y copia tu **App ID** y **App Secret**

### Paso 2: Configurar permisos

1. En tu app de Meta, ve a **App Review → Permissions and Features**
2. Solicita acceso a:
   - `instagram_business_basic` ✅
   - `instagram_business_manage_insights` ✅
3. Para desarrollo/testing, añade tus cuentas de Instagram como **Test Users** en:
   **App Roles → Roles → Add Instagram Testers**

### Paso 3: Desplegar en Render

1. Sube este proyecto a un repositorio de GitHub
2. Ve a [render.com](https://render.com) y crea una cuenta gratuita
3. Haz clic en **"New" → "Web Service"**
4. Conecta tu repositorio de GitHub
5. Render detectará el `render.yaml` automáticamente
6. Configura las **Environment Variables**:
   ```
   INSTAGRAM_APP_ID = (tu App ID de Meta)
   INSTAGRAM_APP_SECRET = (tu App Secret de Meta)
   BASE_URL = https://tu-app.onrender.com
   ```
7. Haz clic en **"Create Web Service"**

### Paso 4: Configurar la Redirect URI

1. Copia la URL de tu app en Render (ej: `https://instametrics-xxxx.onrender.com`)
2. En Meta for Developers, ve a **Instagram → Basic Display** o **Instagram API Settings**
3. Añade esta Redirect URI: `https://instametrics-xxxx.onrender.com/auth/callback`
4. En **App Settings → Basic**, añade tu dominio de Render en **"App Domains"**

### Paso 5: Preparar tus cuentas de Instagram

Cada cuenta que quieras conectar debe ser:
- **Business** o **Creator** (se cambia gratis en Instagram → Ajustes → Cuenta → Cambiar tipo de cuenta)
- NO necesita estar vinculada a Facebook (usamos Business Login)

### Paso 6: ¡Conectar!

1. Abre tu app: `https://tu-app.onrender.com`
2. Haz clic en **"Conectar cuenta"**
3. Autoriza en Instagram
4. ¡Listo! Repite para cada cuenta

---

## 💻 Instalación local (desarrollo)

```bash
# 1. Clonar el proyecto
git clone <tu-repo>
cd instagram-tracker

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
cp .env.example .env
# Edita .env con tu App ID, Secret, y BASE_URL=http://localhost:3000

# 4. Arrancar
npm start

# 5. Abrir http://localhost:3000
```

Para desarrollo local, la Redirect URI en Meta debe ser:
```
http://localhost:3000/auth/callback
```

---

## 🔄 Alternativa: Despliegue en Railway

1. Ve a [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. Añade las variables de entorno (igual que Render)
4. Railway te dará una URL pública automáticamente
5. Usa esa URL como `BASE_URL` y configura la redirect URI en Meta

---

## 📡 Endpoints de la API

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/auth/login` | Inicia el flujo OAuth con Instagram |
| GET | `/auth/callback` | Callback de OAuth (automático) |
| GET | `/api/accounts` | Lista todas las cuentas conectadas |
| DELETE | `/api/accounts/:id` | Desconecta una cuenta |
| GET | `/api/accounts/:id/profile` | Perfil actualizado |
| GET | `/api/accounts/:id/insights` | Métricas de alcance, impresiones |
| GET | `/api/accounts/:id/media` | Últimas publicaciones con métricas |
| GET | `/api/accounts/:id/media/:mediaId/insights` | Insights de un post específico |
| GET | `/api/accounts/:id/demographics` | Datos demográficos de audiencia |
| POST | `/api/accounts/:id/refresh-token` | Renueva el token de acceso |

---

## ⚠️ Cosas a tener en cuenta

- **Tokens expiran en 60 días** — la app te avisa cuando quedan menos de 10 días
- **Rate limit**: 200 llamadas por cuenta por hora
- **Datos de audiencia**: Requiere mínimo 100 seguidores
- **Insights diarios**: Pueden tardar unos días en aparecer en cuentas nuevas
- **App en modo desarrollo**: Solo funciona con cuentas añadidas como testers. Para que cualquiera pueda usarla, necesitas pasar el **App Review** de Meta

---

## 🔒 Seguridad

- Los tokens se almacenan en servidor, nunca se exponen al frontend
- El App Secret nunca sale del backend
- Se usa state parameter para prevenir CSRF en OAuth
- Los datos se guardan en un archivo JSON local (para producción seria, usa una base de datos)

---

## 📋 Compartir con amigos

Para que un amigo use tu app:

1. **Si la app está en modo desarrollo**: Añádelo como Instagram Tester en Meta for Developers (App Roles → Instagram Testers). Él debe aceptar la invitación desde Instagram → Ajustes → Cuenta → Apps y sitios web → Invitaciones de tester
2. **Si la app pasó App Review**: Cualquiera puede conectar su cuenta directamente
3. Comparte el link de tu app desplegada
4. Él solo necesita tener cuenta Business o Creator

---

## 📄 Licencia

MIT — Úsalo como quieras.
