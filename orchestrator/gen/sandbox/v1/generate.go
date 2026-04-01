// Package sandboxv1 contains Go bindings generated from
// proto/sandbox/v1/sandbox.proto.
//
// The .pb.go and _grpc.pb.go files in this directory are compilation stubs
// only.  Run the command below to replace them with fully-functional generated
// code (requires protoc, protoc-gen-go, and protoc-gen-go-grpc on PATH).
//
//	make generate
//
// Or manually:
//
//	protoc \
//	  --go_out=gen \
//	  --go_opt=paths=source_relative \
//	  --go-grpc_out=gen \
//	  --go-grpc_opt=paths=source_relative \
//	  proto/sandbox/v1/sandbox.proto
//
//go:generate protoc --go_out=gen --go_opt=paths=source_relative --go-grpc_out=gen --go-grpc_opt=paths=source_relative proto/sandbox/v1/sandbox.proto
package sandboxv1
