# frozen_string_literal: true

require "json"

module Critiqs
  module Rails
    VERSION = JSON.parse(File.read(File.expand_path("../../../package.json", __dir__))).fetch("version")
  end
end
