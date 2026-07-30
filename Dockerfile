FROM public.ecr.aws/lambda/microvms:al2023-minimal AS toolchain

RUN dnf install -y ruby3.4 ruby3.4-devel gcc gcc-c++ make && \
    dnf clean all && \
    rm -rf /var/cache/dnf
WORKDIR /app
COPY Gemfile Gemfile.lock ./

FROM toolchain AS test

RUN /usr/bin/ruby3.4-bundle config set path /test-bundle && \
    /usr/bin/ruby3.4-bundle install
COPY app.rb config.ru Rakefile ./
COPY test ./test
CMD ["/usr/bin/ruby3.4-bundle", "exec", "rake", "test"]

FROM toolchain AS build

RUN /usr/bin/ruby3.4-bundle config set without test && \
    /usr/bin/ruby3.4-bundle config set path /bundle && \
    /usr/bin/ruby3.4-bundle install

FROM public.ecr.aws/lambda/microvms:al2023-minimal AS runtime

ENV BUNDLE_DEPLOYMENT=1 \
    BUNDLE_PATH=/bundle \
    BUNDLE_WITHOUT=test \
    RACK_ENV=production
RUN dnf install -y ruby3.4 shadow-utils && \
    dnf clean all && \
    rm -rf /var/cache/dnf && \
    groupadd --system --gid 10001 app && \
    useradd --system --uid 10001 --gid app --no-create-home app
WORKDIR /app
COPY --from=build /bundle /bundle
COPY Gemfile Gemfile.lock app.rb config.ru ./
RUN chmod 0444 Gemfile Gemfile.lock app.rb config.ru
USER 10001:10001
EXPOSE 8080
CMD ["/usr/bin/ruby3.4-bundle", "exec", "puma", "-w", "0", "-b", "tcp://0.0.0.0:8080", "config.ru"]
