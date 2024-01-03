# openapi-sdk

## Generate Typesafe SDK from OpenAPI spec

### Usage

for using dynamic base URLs

```bash
pnpm openapi-sdk generate --input openapi/printful.json --base-url process.env.API_BASE_URL --output sdk/printful.ts
```

for using static base URLs

```bash
pnpm openapi-sdk generate --input openapi/printful.json --base-url https://api.printful.com --output sdk/printful.ts
```
