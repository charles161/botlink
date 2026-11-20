package test

import "testing"

// Runs last (file order): which openapi operations did the integration tests exercise?
func TestZZZContractCoverage(t *testing.T) {
	reportCoverage(t)
}
