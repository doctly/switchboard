.PHONY: dev build test

node_modules: package-lock.json
	npm install
	@touch node_modules

dev: node_modules
	npm start

build: node_modules
	npm run build

test: node_modules
	npm test
