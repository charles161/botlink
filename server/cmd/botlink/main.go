// Command botlink is the bot-link v1 server: `botlink` serves, `botlink migrate` applies migrations, `botlink check-config`
// checks the configuration as a start would (no listening, no database).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/server"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))
	if len(os.Args) > 1 && os.Args[1] == "check-config" { // deploy.sh: the config as the server would start with it
		os.Exit(server.CheckConfig(os.Stdout))
	}
	if err := run(); err != nil {
		slog.Error("botlink exited", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv, err := server.New(ctx, cfg)
	if err != nil {
		return err
	}
	defer srv.Close()
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		fmt.Println("migrations applied")
		return nil
	}
	srv.Start(ctx)
	wctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	if err := srv.WaitReady(wctx); err != nil {
		cancel()
		return err
	}
	cancel()

	httpSrv := &http.Server{Addr: cfg.Addr, Handler: srv.Handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second}
	metricsSrv := &http.Server{Addr: cfg.MetricsAddr, Handler: srv.MetricsHandler(), ReadHeaderTimeout: 5 * time.Second}
	errc := make(chan error, 2)
	go func() { errc <- httpSrv.ListenAndServe() }()
	go func() {
		if cfg.MetricsAddr != "" && cfg.MetricsAddr != "off" {
			errc <- metricsSrv.ListenAndServe()
		}
	}()
	slog.Info("botlink listening", "addr", cfg.Addr, "copy", cfg.CopyID, "env", cfg.Env, "metrics", cfg.MetricsAddr,
		"human_check", cfg.HumanCheck, "dev_login", cfg.DevLogin)
	select {
	case <-ctx.Done():
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	// End open waits first (they answer "nothing yet" and the clients poll the next copy), then stop.
	slog.Info("botlink shutting down: ending open waits", "copy", cfg.CopyID)
	sctx, scancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer scancel()
	_ = metricsSrv.Shutdown(sctx)
	start := time.Now()
	err = srv.Shutdown(sctx, httpSrv)
	slog.Info("botlink stopped", "copy", cfg.CopyID, "ms", time.Since(start).Milliseconds(), "err", err)
	return err
}
