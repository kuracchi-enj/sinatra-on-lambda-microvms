# frozen_string_literal: true

require "json"
require "securerandom"
require "sinatra/base"

class App < Sinatra::Base
  HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1"
  REQUEST_ID_PATTERN = /\A[\w.-]{1,128}\z/

  configure do
    set :show_exceptions, false
    set :raise_errors, false
    set :lifecycle_mutex, Mutex.new
    set :ready, false
    set :processed_events, {}
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

    def authorized_hook?
      expected = ENV["LIFECYCLE_HOOK_SECRET"]
      supplied = request.env["HTTP_X_LIFECYCLE_SECRET"]
      return false if expected.nil? || expected.empty? || supplied.nil?
      return false unless expected.bytesize == supplied.bytesize

      Rack::Utils.secure_compare(expected, supplied)
    end

    def hook_payload
      body = request.body.read
      body.empty? ? {} : JSON.parse(body)
    rescue JSON::ParserError
      halt json_response({error: "invalid_json", request_id: request_id}, 400)
    end

    def perform_event_once(payload)
      event_id = payload["eventId"]
      halt json_response({error: "event_id_required", request_id: request_id}, 400) if event_id.to_s.empty?

      settings.lifecycle_mutex.synchronize do
        return false if settings.processed_events.key?(event_id)

        yield
        settings.processed_events[event_id] = true
      end
      true
    end
  end

  before do
    headers "X-Request-Id" => request_id, "Cache-Control" => "no-store"
    content_type :json
  end

  before "#{HOOK_PREFIX}/*" do
    halt json_response({error: "not_found", request_id: request_id}, 404) unless authorized_hook?
  end

  get "/" do
    json_response(
      message: "Sinatra on Lambda MicroVMs",
      pid: Process.pid,
      generation: ENV.fetch("APP_GENERATION", "unknown")
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
    settings.lifecycle_mutex.synchronize { settings.ready = true }
    json_response(status: "ready")
  end

  post "#{HOOK_PREFIX}/validate" do
    json_response(status: "valid")
  end

  post "#{HOOK_PREFIX}/run" do
    payload = hook_payload
    processed = perform_event_once(payload) do
      settings.ready = true
      warn JSON.generate(event: "microvm.run", microvm_id: payload["microvmId"], generation: payload["generation"])
    end
    json_response(status: "ok", duplicate: !processed)
  end

  post "#{HOOK_PREFIX}/suspend" do
    payload = hook_payload
    processed = perform_event_once(payload) { settings.ready = false }
    json_response(status: "suspended", duplicate: !processed)
  end

  post "#{HOOK_PREFIX}/resume" do
    payload = hook_payload
    processed = perform_event_once(payload) { settings.ready = true }
    json_response(status: "ready", duplicate: !processed)
  end

  post "#{HOOK_PREFIX}/terminate" do
    payload = hook_payload
    processed = perform_event_once(payload) { settings.ready = false }
    json_response(status: "terminated", duplicate: !processed)
  end

  not_found do
    json_response({error: "not_found", request_id: request_id}, 404)
  end

  error do
    warn JSON.generate(event: "request.error", request_id: request_id, error: env["sinatra.error"].class.name)
    json_response({error: "internal_server_error", request_id: request_id}, 500)
  end
end
