{
  "name": "@chronos/__NAME__",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "pnpm build && pnpm start",
    "start": "node --import @chronos/service-kit/instrument dist/main.js",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@chronos/config": "workspace:*",
    "@chronos/logger": "workspace:*",
    "@chronos/service-kit": "workspace:*",
    "@nestjs/common": "^12.1.2",
    "@nestjs/core": "^12.1.2",
    "@nestjs/microservices": "^12.1.2",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@chronos/tsconfig": "workspace:*"
  }
}
