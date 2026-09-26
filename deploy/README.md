# Google Cloud Run deployment

This deployment uses Docker images only. The API and database migration are separate Docker targets built from the repository Dockerfile.

## 1. Use an isolated gcloud account configuration

Replace every angle-bracket value before running these commands.

```powershell
gcloud config configurations create parallax-flow-production
gcloud auth login <DEPLOYMENT_EMAIL>
gcloud config set account <DEPLOYMENT_EMAIL>
gcloud config set project <PROJECT_ID>
gcloud config set run/region <REGION>
gcloud auth list
gcloud config list
```

Using a named configuration prevents credentials and project settings from the other Google account from being reused accidentally.

## 2. Enable APIs and create Artifact Registry

```powershell
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
gcloud artifacts repositories create <REPOSITORY> --repository-format=docker --location=<REGION> --description="Parallax Flow production images"
```

If the repository already exists, do not recreate it.

## 3. Generate the production environment YAML

The committed `cloud-run.env.yaml.example` contains placeholders only. The real file is generated from `.env`, is ignored by Git and Docker, and is not uploaded in the Cloud Build context.

```powershell
node scripts/export-cloud-run-env.mjs --public-app-url https://parallaxflow.in
```

The exporter forces `NODE_ENV=production`, `HOST=0.0.0.0`, and `TRUST_PROXY=true`. It validates database URLs, the JWT secret, HTTPS public/CORS URLs, and the explicitly approved fake-payment flags. It intentionally omits `PORT` because Cloud Run reserves and injects that variable.

Keep `deploy/cloud-run.env.yaml` private. It contains production credentials in plain text because `gcloud run --env-vars-file` requires the values locally.

## 4. Build and push immutable Docker images

Use a unique tag such as a Git commit SHA or release number; do not deploy `latest`.

```powershell
$env:PF_RELEASE_TAG = "<IMMUTABLE_RELEASE_TAG>"
gcloud builds submit --config deploy/cloudbuild.yaml --substitutions=_REGION=<REGION>,_REPOSITORY=<REPOSITORY>,_TAG=$env:PF_RELEASE_TAG .
```

This produces:

- `<REGION>-docker.pkg.dev/<PROJECT_ID>/<REPOSITORY>/parallax-flow-api:<TAG>`
- `<REGION>-docker.pkg.dev/<PROJECT_ID>/<REPOSITORY>/parallax-flow-migration:<TAG>`

## 5. Run migrations once from the migration image

Take and verify a database backup first. Never run `prisma db push`, reset, truncate, or seed against production.

```powershell
$env:PF_MIGRATION_IMAGE = "<REGION>-docker.pkg.dev/<PROJECT_ID>/<REPOSITORY>/parallax-flow-migration:$env:PF_RELEASE_TAG"
gcloud run jobs deploy parallax-flow-migrate --image=$env:PF_MIGRATION_IMAGE --region=<REGION> --env-vars-file=deploy/cloud-run.env.yaml --max-retries=0 --task-timeout=15m
gcloud run jobs execute parallax-flow-migrate --region=<REGION> --wait
```

Stop the release if the migration job does not finish successfully.

## 6. Deploy the API image

Create or select a dedicated runtime service account before deployment. The account should receive only the Google Cloud permissions the API actually needs.

```powershell
$env:PF_API_IMAGE = "<REGION>-docker.pkg.dev/<PROJECT_ID>/<REPOSITORY>/parallax-flow-api:$env:PF_RELEASE_TAG"
gcloud run deploy parallax-flow-api --image=$env:PF_API_IMAGE --region=<REGION> --platform=managed --port=8080 --env-vars-file=deploy/cloud-run.env.yaml --service-account=<RUNTIME_SERVICE_ACCOUNT> --allow-unauthenticated --cpu=1 --memory=1Gi --concurrency=40 --timeout=300 --min=0 --max=10
```

`--allow-unauthenticated` makes the HTTP API reachable by the web and mobile clients; application authentication and authorization remain enforced by the backend.

## 7. Verify the deployment

```powershell
$env:PF_API_URL = gcloud run services describe parallax-flow-api --region=<REGION> --format="value(status.url)"
Invoke-RestMethod "$env:PF_API_URL/health/live"
Invoke-RestMethod "$env:PF_API_URL/health/ready"
gcloud run services describe parallax-flow-api --region=<REGION> --format="yaml(status.url,status.latestReadyRevisionName,spec.template.spec.containers)"
```

After both endpoints return success, configure the web and mobile production API environment variables with the Cloud Run service URL and rebuild those clients.

## Rollback

Redeploy the previous immutable API image tag. Do not reverse database migrations unless a separately reviewed reverse migration exists.