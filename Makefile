.PHONY: dev down verify

dev:
	./docker/dev-local.sh

down:
	docker compose -f docker/compose.yml down

verify:
	pnpm typecheck
	pnpm lint
	pnpm test
	pnpm build
