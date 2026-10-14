package projectdom

import (
	"errors"
	"testing"

	"github.com/google/uuid"
)

func TestMemberCursor_RoundTrip(t *testing.T) {
	m := &ProjectMember{ID: uuid.New()}
	got, err := DecodeMemberCursor(EncodeMemberCursor(m))
	if err != nil || got != m.ID {
		t.Fatalf("got %v, %v; want %v", got, err, m.ID)
	}
}

func TestDecodeMemberCursor_RejectsGarbage(t *testing.T) {
	for _, in := range []string{"!!!", "e30=", "eyJpZCI6Im5vcGUifQ=="} {
		if _, err := DecodeMemberCursor(in); !errors.Is(err, ErrInvalidMemberCursor) {
			t.Errorf("%q: err = %v, want ErrInvalidMemberCursor", in, err)
		}
	}
}
