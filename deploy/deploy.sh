#!/usr/bin/env bash
# Build, test, audit, and deploy dub_partner (apps/web) to EC2.
#
# Pipeline:
#   1. Dependency audit (warns, does not block)
#   2. Unit tests against your LOCAL dev DB (hard fail)
#   3. Package source + Docker build/push via CodeBuild, using AWS's
#      15GB build container instead of this machine (local next build
#      needs ~12GB heap and reliably OOMs on an 8GB dev machine)
#   4. SSH to the EC2 instance: pull the new image, run pending Prisma
#      migrations against the real DB, restart the container
#   5. Health check the running app
#
# Usage: ./deploy/deploy.sh
set -euo pipefail

# ---- config: fill in once the EC2 instance exists ----
AWS_REGION="ap-south-1"
AWS_ACCOUNT_ID="348881530370"
ECR_REPO="affiliate"
CODEBUILD_PROJECT="affiliate-build"
S3_SOURCE_BUCKET="affiliate-codebuild-source-348881530370"
EC2_HOST="${EC2_HOST:?Set EC2_HOST to the instance's IP/DNS, e.g. EC2_HOST=1.2.3.4 ./deploy/deploy.sh}"
EC2_USER="ec2-user"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/affiliate-ec2-key.pem}"
CONTAINER_NAME="affiliate-app"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"

step() { echo; echo "==> $1"; }

# ---- 1. dependency audit (non-blocking) ----
step "[1/5] Dependency audit"
cd "$REPO_ROOT"
if ! pnpm audit --audit-level=high; then
  echo "    ⚠ pnpm audit found high/critical issues (see above). Continuing —"
  echo "      review these, but they don't block deploy on their own."
fi

# ---- 2. unit tests (hard fail) — needs your local docker-compose DB running ----
step "[2/5] Running test suite (apps/web)"
(cd apps/web && pnpm test)

# ---- 3. package source + build/push via CodeBuild ----
step "[3/5] Packaging source"
TMP_ZIP="$(mktemp -t dub-source-XXXX).zip"
git archive --format=zip -o "$TMP_ZIP" HEAD
# deploy/Dockerfile, .dockerignore, buildspec.yml are tracked in the repo but
# CodeBuild's source.zip needs them at the ZIP ROOT, not under deploy/.
TMP_INJECT="$(mktemp -d)"
cp deploy/Dockerfile deploy/.dockerignore deploy/buildspec.yml "$TMP_INJECT/"
(cd "$TMP_INJECT" && zip -q "$TMP_ZIP" Dockerfile .dockerignore buildspec.yml)
rm -rf "$TMP_INJECT"

step "[3/5] Uploading source + starting CodeBuild"
aws s3 cp "$TMP_ZIP" "s3://${S3_SOURCE_BUCKET}/source.zip" --region "$AWS_REGION"
rm -f "$TMP_ZIP"
BUILD_ID=$(aws codebuild start-build --project-name "$CODEBUILD_PROJECT" --region "$AWS_REGION" --query "build.id" --output text)
echo "    build: $BUILD_ID"

step "[3/5] Waiting for build (usually ~10 min)"
while true; do
  BUILD_STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$AWS_REGION" --query "builds[0].buildStatus" --output text)
  [ "$BUILD_STATUS" != "IN_PROGRESS" ] && break
  sleep 15
done
if [ "$BUILD_STATUS" != "SUCCEEDED" ]; then
  echo "    ✗ build $BUILD_STATUS — aborting deploy. Check CloudWatch logs:"
  echo "      /aws/codebuild/${CODEBUILD_PROJECT}  stream: ${BUILD_ID##*:}"
  exit 1
fi
echo "    ✓ build succeeded, image pushed to ${IMAGE_URI}:latest"

# ---- 4. deploy to EC2 ----
step "[4/5] Deploying to ${EC2_HOST}"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "${EC2_USER}@${EC2_HOST}" bash -s <<REMOTE
  set -euo pipefail
  aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com
  docker pull ${IMAGE_URI}:latest

  # run pending migrations against the real DB before swapping the container
  docker run --rm --env-file /home/${EC2_USER}/.env ${IMAGE_URI}:latest \
    sh -c "cd /app/apps/web && pnpm exec prisma migrate deploy --schema=./prisma/schema"

  docker stop ${CONTAINER_NAME} 2>/dev/null || true
  docker rm ${CONTAINER_NAME} 2>/dev/null || true
  docker run -d --name ${CONTAINER_NAME} --restart unless-stopped \
    -p 3000:3000 --env-file /home/${EC2_USER}/.env ${IMAGE_URI}:latest
REMOTE

# ---- 5. health check ----
step "[5/5] Health check"
sleep 5
if curl -sf -o /dev/null "http://${EC2_HOST}:3000/"; then
  echo "    ✓ app is responding on ${EC2_HOST}:3000"
else
  echo "    ⚠ app did not respond on port 3000 — check 'docker logs ${CONTAINER_NAME}' on the instance"
  exit 1
fi

echo
echo "✅ Deploy complete"
