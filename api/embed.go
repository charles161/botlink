// Package apispec embeds the OpenAPI contract served at /api/openapi.yaml. Contract shim: do not rename.
package apispec

import _ "embed"

//go:embed openapi.yaml
var OpenAPI []byte
