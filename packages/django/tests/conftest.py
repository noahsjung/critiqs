import django
from django.conf import settings


def pytest_configure():
    settings.configure(
        DEBUG=True,
        SECRET_KEY="tests",
        ROOT_URLCONF="tests.urls",
        ALLOWED_HOSTS=["testserver"],
        INSTALLED_APPS=["django.contrib.staticfiles", "django_critiqs"],
        STATIC_URL="/static/",
        TEMPLATES=[
            {
                "BACKEND": "django.template.backends.django.DjangoTemplates",
                "APP_DIRS": True,
                "OPTIONS": {"context_processors": ["django.template.context_processors.request"]},
            }
        ],
    )
    django.setup()
