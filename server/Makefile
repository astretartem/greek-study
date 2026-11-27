# make test    — tests with the race detector
# make build   — Linux binaries (arm64 for Ampere, amd64 for E2.1.Micro) into bin/
# make deploy HOST=1.2.3.4 — build, copy to the server and run setup.sh
KEY ?= ~/.ssh/oracle_greek
SSH_USER ?= ubuntu

.PHONY: test build deploy
test:
	go vet ./... && go test -race -count=1 ./...

build:
	for a in arm64 amd64; do CGO_ENABLED=0 GOOS=linux GOARCH=$$a go build -trimpath -ldflags="-s -w" -o bin/greek-signaling-linux-$$a . || exit 1; done

deploy: test build
	@test -n "$(HOST)" || (echo "Specify HOST=<server IP>"; exit 1)
	ssh -i $(KEY) $(SSH_USER)@$(HOST) 'mkdir -p ~/greek-signaling/bin'
	scp -i $(KEY) setup.sh $(SSH_USER)@$(HOST):~/greek-signaling/
	scp -i $(KEY) bin/greek-signaling-linux-* $(SSH_USER)@$(HOST):~/greek-signaling/bin/
	ssh -i $(KEY) $(SSH_USER)@$(HOST) 'sudo bash ~/greek-signaling/setup.sh'
