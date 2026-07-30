# frozen_string_literal: true

ENV["RACK_ENV"] = "test"
ENV["LIFECYCLE_HOOK_SECRET"] = "test-secret"

require "minitest/autorun"
require "rack/test"
require_relative "../app"

class AppTest < Minitest::Test
  include Rack::Test::Methods

  def app = App

  def setup
    App.settings.lifecycle_mutex.synchronize do
      App.settings.ready = false
      App.settings.processed_events = {}
    end
  end

  def parsed_body = JSON.parse(last_response.body)

  def hook(path, body = {})
    post "#{App::HOOK_PREFIX}/#{path}", JSON.generate(body), {
      "CONTENT_TYPE" => "application/json",
      "HTTP_X_LIFECYCLE_SECRET" => "test-secret"
    }
  end

  def test_root_returns_contract_and_request_id
    get "/", {}, "HTTP_X_REQUEST_ID" => "request-123"

    assert last_response.ok?
    assert_equal "Sinatra on Lambda MicroVMs", parsed_body["message"]
    assert_equal "unknown", parsed_body["generation"]
    assert_equal "request-123", last_response["X-Request-Id"]
    assert_equal "no-store", last_response["Cache-Control"]
  end

  def test_readiness_tracks_lifecycle
    get "/health/ready"
    assert_equal 503, last_response.status

    hook "ready"
    get "/health/ready"
    assert_equal 200, last_response.status

    hook "suspend", "eventId" => "suspend-1"
    get "/health/ready"
    assert_equal 503, last_response.status
  end

  def test_lifecycle_hooks_are_protected
    post "#{App::HOOK_PREFIX}/ready"

    assert_equal 404, last_response.status
  end

  def test_event_hooks_require_an_event_id
    hook "resume"

    assert_equal 400, last_response.status
    assert_equal "event_id_required", parsed_body["error"]
  end

  def test_duplicate_events_are_idempotent
    hook "resume", "eventId" => "resume-1"
    refute parsed_body["duplicate"]

    hook "resume", "eventId" => "resume-1"
    assert parsed_body["duplicate"]
  end

  def test_invalid_request_id_is_replaced
    get "/", {}, "HTTP_X_REQUEST_ID" => "invalid request id"

    refute_equal "invalid request id", last_response["X-Request-Id"]
    assert_match(/\A[0-9a-f-]{36}\z/, last_response["X-Request-Id"])
  end
end
