FROM apache/airflow:2.10.5-python3.11

USER root
# Java for local PySpark
RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jre-headless curl \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64

USER airflow
ARG AIRFLOW_VERSION=2.10.5
RUN pip install --no-cache-dir \
      "apache-airflow==${AIRFLOW_VERSION}" \
      "apache-airflow-providers-databricks" \
      "pyspark==3.5.3" "delta-spark==3.2.1" "mlflow==2.17.2" "scikit-learn>=1.3" \
      "boto3>=1.34" "pymysql>=1.1" "pyarrow>=14" "anthropic>=0.75" "pydantic>=2.6" "yfinance>=0.2.40"

# Bake the S3A + Delta jars into PySpark so jobs start without Maven downloads.
RUN JARS=$(python -c "import pyspark,os;print(os.path.join(os.path.dirname(pyspark.__file__),'jars'))") \
 && cd "$JARS" \
 && curl -fsSLO https://repo1.maven.org/maven2/org/apache/hadoop/hadoop-aws/3.3.4/hadoop-aws-3.3.4.jar \
 && curl -fsSLO https://repo1.maven.org/maven2/com/amazonaws/aws-java-sdk-bundle/1.12.262/aws-java-sdk-bundle-1.12.262.jar \
 && curl -fsSLO https://repo1.maven.org/maven2/io/delta/delta-spark_2.12/3.2.1/delta-spark_2.12-3.2.1.jar \
 && curl -fsSLO https://repo1.maven.org/maven2/io/delta/delta-storage/3.2.1/delta-storage-3.2.1.jar

COPY --chown=airflow:root pipeline /opt/finsent/pipeline
COPY --chown=airflow:root databricks /opt/finsent/databricks
RUN pip install --no-cache-dir --no-deps /opt/finsent/pipeline /opt/finsent/databricks

COPY --chown=airflow:root airflow/entrypoint.sh /opt/finsent/entrypoint.sh
ENTRYPOINT ["/usr/bin/dumb-init", "--", "bash", "/opt/finsent/entrypoint.sh"]
