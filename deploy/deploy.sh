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
# Elastic IP — stable across instance stop/start, no export needed for the
# normal case. Override with EC2_HOST=... if targeting a different instance.
EC2_HOST="${EC2_HOST:-13.205.153.233}"
EC2_USER="ec2-user"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/dub-partner-deploy-key.pem}"
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
# Excludes tests that import tests/utils/integration* — those need a live
# deployed server + real API tokens (E2E_BASE_URL, E2E_TOKEN, ...) and can
# never pass in a local pre-deploy gate. Computed at run-time (not a static
# list) so it stays correct as the test suite evolves.
step "[2/5] Running test suite (apps/web)"
(
  cd apps/web
  pnpm prisma:generate
  # NOTE: vitest's --exclude only accumulates across repeats in the
  # --exclude="pattern" (equals-sign) form; --exclude "pattern" (space-
  # separated) silently drops all but one occurrence. Patterns also must be
  # relative to vitest.config.ts's `dir: "./tests"` (no "tests/" prefix) and
  # need a "**/" prefix, or they silently match nothing.
  EXCLUDE_ARGS=()
  while IFS= read -r f; do
    EXCLUDE_ARGS+=(--exclude="**/${f#tests/}")
  done < <(grep -rl "utils/integration" tests --include="*.test.ts")
  # webhooks test publishes via real QStash, whose callback URL is built from
  # APP_DOMAIN_WITH_NGROK — without a real ngrok tunnel this resolves to
  # localhost, which QStash's cloud service can't reach, so it fails
  # synchronously. Needs NEXT_PUBLIC_NGROK_URL set to run for real.
  EXCLUDE_ARGS+=(--exclude="**/webhooks/index.test.ts")
  echo "    (skipping ${#EXCLUDE_ARGS[@]} tests that need live external infra: E2E server+tokens, or an ngrok tunnel)"
  CI=true pnpm exec dotenv-flow -e .env -- vitest run -no-file-parallelism --bail=1 "${EXCLUDE_ARGS[@]}"
)

# ---- 3. package source + build/push via CodeBuild ----
step "[3/5] Packaging source"
TMP_ZIP="$(mktemp -t dub-source-XXXX).zip"
# NOTE: this deliberately packages the current WORKING TREE, not `git archive
# HEAD` (committed-only). This repo has an external process that auto-commits
# at unpredictable times, so HEAD can lag behind what's actually on disk by
# the time this runs — a build from HEAD silently shipped stale code that way
# once already. `git ls-files --cached --others --exclude-standard` lists
# every tracked file (read at its current on-disk content, uncommitted edits
# included) plus untracked-but-not-gitignored files — .env is gitignored, so
# this is as safe against secret leaks as `git archive` was.
rm -f "$TMP_ZIP"
git ls-files -z --cached --others --exclude-standard | xargs -0 zip -q "$TMP_ZIP"
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
# NOTE: this project has no prisma/migrations directory — schema changes are
# applied via `pnpm prisma:push`, a deliberate manual step reviewed by a
# human (it can be destructive), never auto-run here against production.
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "${EC2_USER}@${EC2_HOST}" bash -s <<REMOTE
  set -euo pipefail
  aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com
  docker pull ${IMAGE_URI}:latest
  docker image prune -af

  docker stop ${CONTAINER_NAME} 2>/dev/null || true
  docker rm ${CONTAINER_NAME} 2>/dev/null || true
  # --network ps-net: connects to the ps-http-proxy sidecar (ghcr.io/
  # mattrobenolt/ps-http-sim, bridges PLANETSCALE_DATABASE_URL to the real
  # RDS instance) — prismaEdge and lib/planetscale/* need this reachable
  # or every edge/middleware DB call fails with ERR_SSL_WRONG_VERSION_NUMBER.
  docker run -d --name ${CONTAINER_NAME} --restart unless-stopped \
    --network ps-net \
    -p 3000:3000 --env-file /home/${EC2_USER}/.env ${IMAGE_URI}:latest
REMOTE

# ---- 5. health check ----
# Goes through the real public domain (DNS -> ALB -> target group -> app),
# not http://$EC2_HOST:3000 directly — affiliate-ec2-sg only allows port
# 3000 inbound from the ALB's security group, so a direct check from an
# external machine (anyone actually running this script) always times out
# regardless of whether the deploy succeeded. This also verifies the whole
# path real users hit, not just "is the container up".
LIVE_URL="https://partners.spacemarvel.com"
step "[5/5] Health check"
sleep 5
if curl -sf -o /dev/null -m 15 "${LIVE_URL}/api/health"; then
  echo
  echo -e "\033[1;32m✅ DEPLOYMENT SUCCESSFUL — live at: ${LIVE_URL}\033[0m"
else
  echo
  echo -e "\033[1;31m✗ DEPLOYMENT FAILED — ${LIVE_URL}/api/health did not respond\033[0m"
  echo "  Check: ssh -i \"$SSH_KEY\" ${EC2_USER}@${EC2_HOST} 'docker logs ${CONTAINER_NAME}'"
  exit 1
fi
