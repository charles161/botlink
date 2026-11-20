package httpx

import "testing"

func TestDuplicateKeys(t *testing.T) {
	for _, bad := range []string{`{"a":1,"a":2}`, `{"x":{"b":1,"b":1}}`, `[{"k":1,"k":2}]`, `{"a":1} {}`} {
		if CheckNoDuplicateKeys([]byte(bad)) == nil {
			t.Errorf("%s accepted", bad)
		}
	}
	for _, ok := range []string{`{"a":1,"b":{"a":2}}`, `[{"k":1},{"k":2}]`, `"s"`, `{}`} {
		if err := CheckNoDuplicateKeys([]byte(ok)); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	var v struct{ A int }
	if DecodeStrict([]byte(`{"A":1,"B":2}`), &v) == nil {
		t.Error("unknown field accepted")
	}
}
