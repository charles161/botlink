# bot-link v1 · server / db targets. Go: the one on PATH (~/.local/go/bin is added for machines that keep it there).
SHELL := /bin/bash
GO      ?= go
export PATH := $(HOME)/.local/go/bin:$(HOME)/go/bin:$(PATH)

PGBIN   ?= /usr/lib/postgresql/16/bin
PGDATA  := $(CURDIR)/.dev/pg
PGPORT  ?= 55432
PGURL   := postgres://botlink@127.0.0.1:$(PGPORT)
DBS     := botlink_dev botlink_test_server botlink_test_client

# Dev defaults (no secrets).
export BOTLINK_ENV          ?= dev
export BOTLINK_DATABASE_URL ?= $(PGURL)/botlink_dev
export BOTLINK_APP_ORIGIN   ?= http://localhost:8811
export BOTLINK_DEV_LOGIN    ?= 1
export BOTLINK_HUMAN_CHECK  ?= stub

# The tests set their own settings: the dev defaults above must not leak into them (a prod-mode config test fails with
# BOTLINK_DEV_LOGIN=1 in its environment).
TESTENV := env -u BOTLINK_ENV -u BOTLINK_DATABASE_URL -u BOTLINK_APP_ORIGIN -u BOTLINK_DEV_LOGIN -u BOTLINK_HUMAN_CHECK

.PHONY: db-up db-down db-reset migrate sqlc build run run2 test test-race vet twocopy

db-up:
	@mkdir -p .dev
	@if [ ! -f $(PGDATA)/PG_VERSION ]; then $(PGBIN)/initdb -D $(PGDATA) -A trust -U botlink >/dev/null; fi
	@if ! $(PGBIN)/pg_ctl -D $(PGDATA) status >/dev/null 2>&1; then \
	  $(PGBIN)/pg_ctl -D $(PGDATA) -o "-p $(PGPORT) -k $(CURDIR)/.dev -c listen_addresses=127.0.0.1 -c max_connections=300" -l .dev/pg.log -w start; fi
	@for d in $(DBS); do \
	  $(PGBIN)/psql "$(PGURL)/postgres" -tAc "select 1 from pg_database where datname='$$d'" | grep -q 1 || \
	  $(PGBIN)/psql "$(PGURL)/postgres" -qc "create database $$d"; done
	@echo "postgres up on 127.0.0.1:$(PGPORT) ($(DBS))"

db-down:
	@$(PGBIN)/pg_ctl -D $(PGDATA) stop -m fast || true

db-reset: db-up
	@$(PGBIN)/psql "$(PGURL)/postgres" -qc "drop database if exists botlink_dev with (force)" -c "create database botlink_dev"

migrate: build
	./.dev/bin/botlink migrate

build:
	@mkdir -p .dev/bin
	$(GO) build -o .dev/bin/botlink ./server/cmd/botlink

# Copy A on :8811, copy B on :8812, same database.
run: build
	BOTLINK_ADDR=:8811 BOTLINK_COPY_ID=A BOTLINK_METRICS_ADDR=127.0.0.1:9811 ./.dev/bin/botlink

run2: build
	BOTLINK_ADDR=:8812 BOTLINK_COPY_ID=B BOTLINK_METRICS_ADDR=127.0.0.1:9812 ./.dev/bin/botlink

vet:
	$(GO) vet ./server/...

test: db-up
	$(TESTENV) BOTLINK_TEST_DATABASE_URL=$(PGURL)/botlink_test_server $(GO) test -count=1 ./server/...

test-race: db-up
	$(TESTENV) BOTLINK_TEST_DATABASE_URL=$(PGURL)/botlink_test_server $(GO) test -race -count=1 -timeout 30m ./server/...

# Two real processes (A :8811, B :8812) on one DB; see server/test/twocopy_test.go.
twocopy: db-up build
	$(TESTENV) BOTLINK_TEST_DATABASE_URL=$(PGURL)/botlink_test_server BOTLINK_TWOCOPY_BIN=$(CURDIR)/.dev/bin/botlink \
	  $(GO) test -count=1 -run 'TestTwoCopy' -v ./server/test/
