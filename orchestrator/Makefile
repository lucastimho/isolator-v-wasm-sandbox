.PHONY: build run test lint proto tidy docker-up docker-down

# ── Build ─────────────────────────────────────────────────────────────────────
build:
	go build -o bin/orchestrator ./cmd/server

run: build
	./bin/orchestrator

# ── Deps ──────────────────────────────────────────────────────────────────────
tidy:
	go mod tidy

# ── Test ──────────────────────────────────────────────────────────────────────
test:
	go test ./... -race -timeout 60s

lint:
	golangci-lint run ./...

# ── Proto codegen ─────────────────────────────────────────────────────────────
# Requires: protoc, protoc-gen-go, protoc-gen-go-grpc
#   brew install protobuf
#   go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
#   go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
proto:
	@mkdir -p gen/sandbox/v1
	protoc \
		--go_out=gen \
		--go_opt=paths=source_relative \
		--go-grpc_out=gen \
		--go-grpc_opt=paths=source_relative \
		proto/sandbox/v1/sandbox.proto
	@echo "✔ Proto stubs generated in gen/"

# ── Local infrastructure ──────────────────────────────────────────────────────
docker-up:
	docker compose up -d

docker-down:
	docker compose down
