{
  "name": "{{NAME}}",
  "version": "{{VERSION}}",
  "description": "{{DESCRIPTION}}",
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": {
      "default": "./index.js"
    },
    "./client": {
      "default": "./lib/client.js"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "index.js",
    "lib/**/*.js",
    "lib/**/*.mjs",
    "cordis.patch.yml",
    "README.md"
  ],
  "engines": {
    "node": ">=20.0.0",
    "dsh": ">=0.1.2-rc.1"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "inject": []
    }
  },
  "license": "MIT",
  "private": true
}
