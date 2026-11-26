# frozen_string_literal: true

require "critiqs/rails/version"
require "critiqs/rails/engine"

module Critiqs
  module Rails
    # The browser bundle's logical path in the asset pipeline.
    ELEMENT_ASSET = "critiqs/element.js"
    # The gem's own module that reports each page's context to the element.
    CONTEXT_ASSET = "critiqs/context.js"
  end
end
