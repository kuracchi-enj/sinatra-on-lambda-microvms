FROM ruby:3.4-slim AS build

RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Gemfile Gemfile.lock ./
RUN bundle config set without test && \
    bundle config set path /bundle && \
    bundle install

FROM ruby:3.4-slim AS runtime

ENV BUNDLE_DEPLOYMENT=1 \
    BUNDLE_PATH=/bundle \
    RACK_ENV=production
RUN groupadd --system --gid 10001 app && \
    useradd --system --uid 10001 --gid app --no-create-home app
WORKDIR /app
COPY --from=build /bundle /bundle
COPY --chown=app:app app.rb config.ru ./
USER 10001:10001
EXPOSE 8080
CMD ["bundle", "exec", "puma", "-w", "0", "-b", "tcp://0.0.0.0:8080", "config.ru"]
