# frozen_string_literal: true

require "json"

Gem::Specification.new do |spec|
  spec.name = "critiqs-rails"
  # One version for every Critiqs package: package.json is in the release group that sets it.
  spec.version = JSON.parse(File.read(File.join(__dir__, "package.json"))).fetch("version")
  spec.authors = ["Noah Jung"]
  spec.summary = "Critiqs for Ruby on Rails apps: comment on an interactive prototype, discuss feedback, and find its context."
  spec.description = "Adds Critiqs to a Rails app's pages with one view helper, critiqs_tag, and serves Critiqs's browser bundle through the app's asset pipeline (Propshaft or Sprockets)."
  spec.homepage = "https://github.com/noahsjung/Critiqs/tree/main/packages/rails#readme"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.3"
  spec.metadata = {
    "homepage_uri" => spec.homepage,
    "source_code_uri" => "https://github.com/noahsjung/Critiqs/tree/main/packages/rails",
    "bug_tracker_uri" => "https://github.com/noahsjung/Critiqs/issues",
    "rubygems_mfa_required" => "true",
  }

  # app/assets/javascripts/critiqs/element.js isn't in Git: `bun run release:build` copies it from the built critiqs package.
  spec.files = Dir["app/**/*", "lib/**/*", "package.json", "README.md", "LICENSE"]
  spec.require_paths = ["lib"]

  spec.add_dependency "railties", ">= 7.1"
  spec.add_dependency "actionview", ">= 7.1"
end
