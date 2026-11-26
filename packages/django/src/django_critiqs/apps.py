from django.apps import AppConfig
from django.core import checks

from .conf import check_settings


class CritiqsConfig(AppConfig):
    name = "django_critiqs"
    verbose_name = "Critiqs"

    def ready(self):
        checks.register(check_settings)
