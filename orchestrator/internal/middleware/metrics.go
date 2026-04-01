package middleware

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	httpRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "orchestrator_http_requests_total",
		Help: "Total number of HTTP requests handled by the orchestrator.",
	}, []string{"method", "path", "status"})

	httpDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "orchestrator_http_duration_seconds",
		Help: "HTTP request latency distribution.",
		// Buckets chosen to highlight the sub-50ms target from the blueprint.
		Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5},
	}, []string{"method", "path"})

	poolWarmSlots = promauto.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "orchestrator_pool_warm_slots",
		Help: "Number of immediately available warm worker slots.",
	}, func() float64 { return warmSlotsGaugeFn() })
)

// warmSlotsGaugeFn is set by RegisterPoolGauge so the Prometheus gauge can
// read pool stats without importing the pool package (avoids circular imports).
var warmSlotsGaugeFn = func() float64 { return 0 }

// RegisterPoolGauge wires the pool stats function into the Prometheus gauge.
// Call this once after creating the Manager.
func RegisterPoolGauge(fn func() float64) {
	warmSlotsGaugeFn = fn
}

// statusRecorder wraps http.ResponseWriter to capture the status code.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// Prometheus records per-route request counts and latency.
// Use with chi: r.Use(middleware.Prometheus).
func Prometheus(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

		next.ServeHTTP(rec, r)

		path := r.URL.Path
		httpRequests.WithLabelValues(r.Method, path, strconv.Itoa(rec.status)).Inc()
		httpDuration.WithLabelValues(r.Method, path).Observe(time.Since(start).Seconds())
	})
}
