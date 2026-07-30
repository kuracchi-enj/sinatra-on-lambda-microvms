# frozen_string_literal: true

require "json"
require "securerandom"
require "sinatra/base"
require "time"

class App < Sinatra::Base
  HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1"
  REQUEST_ID_PATTERN = /\A[\w.-]{1,128}\z/

  configure do
    set :show_exceptions, false
    set :raise_errors, false
    set :lifecycle_mutex, Mutex.new
    set :ready, false
    set :generation, "unassigned"
    set :microvm_id, nil
    set :runtime_initialized, false
  end

  helpers do
    def json_response(body, code = 200)
      content_type :json
      status code
      JSON.generate(body)
    end

    def request_id
      supplied = request.env["HTTP_X_REQUEST_ID"]
      @request_id ||= REQUEST_ID_PATTERN.match?(supplied.to_s) ? supplied : SecureRandom.uuid
    end

    def hook_payload
      body = request.body.read
      body.empty? ? {} : JSON.parse(body)
    rescue JSON::ParserError
      halt json_response({error: "invalid_json", request_id: request_id}, 400)
    end

    def run_configuration(payload)
      microvm_id = payload["microvmId"].to_s
      halt json_response({error: "microvm_id_required", request_id: request_id}, 400) if microvm_id.empty?

      raw = payload["runHookPayload"].to_s
      config = raw.empty? ? {} : JSON.parse(raw)
      generation = config.fetch("generation", 1)
      unless generation.is_a?(Integer) && generation.positive?
        halt json_response({error: "invalid_generation", request_id: request_id}, 400)
      end

      [microvm_id, generation]
    rescue JSON::ParserError
      halt json_response({error: "invalid_run_hook_payload", request_id: request_id}, 400)
    end

    def lifecycle_log(event, outcome: "success")
      warn JSON.generate(
        timestamp: Time.now.utc.iso8601(3),
        level: "INFO",
        service: "sinatra-microvm",
        event: event,
        request_id: request_id,
        microvm_id: settings.microvm_id,
        generation: settings.generation,
        lifecycle_state: settings.ready ? "RUNNING" : "NOT_READY",
        outcome: outcome
      )
    end
  end

  before do
    headers "X-Request-Id" => request_id, "Cache-Control" => "no-store"
    content_type :json
  end

  get "/" do
    json_response(
      message: "Sinatra on Lambda MicroVMs",
      pid: Process.pid,
      generation: settings.lifecycle_mutex.synchronize { settings.generation }
    )
  end

  get "/health/live" do
    json_response(status: "ok")
  end

  get "/health/ready" do
    ready = settings.lifecycle_mutex.synchronize { settings.ready }
    json_response({status: ready ? "ready" : "not_ready"}, ready ? 200 : 503)
  end

  post "#{HOOK_PREFIX}/ready" do
    # Listener readiness is distinct from tenant request readiness. The run hook
    # must establish and validate this VM's runtime identity first.
    json_response(status: "listener_ready")
  end

  post "#{HOOK_PREFIX}/validate" do
    json_response(status: "valid")
  end

  post "#{HOOK_PREFIX}/run" do
    payload = hook_payload
    microvm_id, generation = run_configuration(payload)
    duplicate = settings.lifecycle_mutex.synchronize do
      if settings.runtime_initialized
        halt json_response({error: "runtime_identity_mismatch", request_id: request_id}, 409) unless
          settings.microvm_id == microvm_id && settings.generation == generation
        true
      else
        # Runtime-specific values must only be initialized after the image
        # snapshot has been restored for a concrete MicroVM.
        settings.microvm_id = microvm_id
        settings.generation = generation
        settings.runtime_initialized = true
        settings.ready = true
        false
      end
    end
    unless duplicate
      lifecycle_log("microvm.run")
    end
    json_response(status: "ok", duplicate: duplicate)
  end

  post "#{HOOK_PREFIX}/suspend" do
    settings.lifecycle_mutex.synchronize { settings.ready = false }
    lifecycle_log("microvm.suspend")
    json_response(status: "suspended")
  end

  post "#{HOOK_PREFIX}/resume" do
    initialized = settings.lifecycle_mutex.synchronize do
      next false unless settings.runtime_initialized

      # Reconnect external pools and refresh short-lived credentials here as
      # those dependencies are added. No external connection is held today.
      settings.ready = true
      true
    end
    halt json_response({error: "runtime_not_initialized", request_id: request_id}, 503) unless initialized

    lifecycle_log("microvm.resume")
    json_response(status: "ready")
  end

  post "#{HOOK_PREFIX}/terminate" do
    settings.lifecycle_mutex.synchronize { settings.ready = false }
    lifecycle_log("microvm.terminate")
    json_response(status: "terminated")
  end

  not_found do
    json_response({error: "not_found", request_id: request_id}, 404)
  end

  error do
    warn JSON.generate(event: "request.error", request_id: request_id, error: env["sinatra.error"].class.name)
    json_response({error: "internal_server_error", request_id: request_id}, 500)
  end
end
