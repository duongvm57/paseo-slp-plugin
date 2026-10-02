# Container harness for paseo-slp: install acceptance + disposable serve mode.
# Everything runs inside Docker against a read-only mount of this checkout;
# no host paseo home, credentials, or daemon state is touched.
IMAGE := paseo-slp-container-harness:node24-paseo0.9.2

.PHONY: test-container serve serve-stop serve-logs image clean

# One-command install acceptance: build + run, prints CONTAINER_ACCEPTANCE_OK.
test-container: ; ./run

# Disposable daemon + web UI on host loopback: http://127.0.0.1:$(PORT)/
serve: ; ./serve $(PORT)
serve-logs: ; docker logs -f paseo-slp-container-serve
serve-stop: ; ./stop

image: ; docker build --tag $(IMAGE) .
clean: serve-stop ; docker image rm $(IMAGE)
