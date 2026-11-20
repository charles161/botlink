// Package db embeds the SQL migrations for the server's migration runner. Contract shim: do not rename.
package db

import "embed"

//go:embed migrations/*.sql
var Migrations embed.FS
