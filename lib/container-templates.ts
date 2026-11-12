// One-click apps that ship with OMP UI: popular images from Docker Hub with sensible defaults
// (ports, volumes, env) and a few common compose stacks. The Containers page merges these with
// the Portainer app catalog fetched at runtime (see lib/docker-catalog.ts).
import type { ContainerTemplate } from "@/lib/docker-types";

const icon = (slug: string) => `https://cdn.simpleicons.org/${slug}`;

const CONTAINERS: ContainerTemplate[] = [
  {
    id: "postgres",
    title: "PostgreSQL",
    description: "Relational database. Connect with postgres://postgres:<password>@localhost:5432/postgres.",
    categories: ["database"],
    logo: icon("postgresql"),
    image: "postgres:17-alpine",
    ports: ["5432/tcp"],
    volumes: [{ container: "/var/lib/postgresql/data" }],
    env: [
      { name: "POSTGRES_PASSWORD", label: "Password", secret: true },
      { name: "POSTGRES_USER", label: "User", default: "postgres" },
      { name: "POSTGRES_DB", label: "Database", default: "postgres" },
    ],
  },
  {
    id: "mysql",
    title: "MySQL",
    description: "The MySQL relational database (LTS).",
    categories: ["database"],
    logo: icon("mysql"),
    image: "mysql:8.4",
    ports: ["3306/tcp"],
    volumes: [{ container: "/var/lib/mysql" }],
    env: [
      { name: "MYSQL_ROOT_PASSWORD", label: "Root password", secret: true },
      { name: "MYSQL_DATABASE", label: "Database", default: "app" },
    ],
  },
  {
    id: "mariadb",
    title: "MariaDB",
    description: "Community-developed fork of MySQL.",
    categories: ["database"],
    logo: icon("mariadb"),
    image: "mariadb:11",
    ports: ["3306/tcp"],
    volumes: [{ container: "/var/lib/mysql" }],
    env: [
      { name: "MARIADB_ROOT_PASSWORD", label: "Root password", secret: true },
      { name: "MARIADB_DATABASE", label: "Database", default: "app" },
    ],
  },
  {
    id: "mongo",
    title: "MongoDB",
    description: "Document database. Leave the user empty for no authentication.",
    categories: ["database"],
    logo: icon("mongodb"),
    image: "mongo:8",
    ports: ["27017/tcp"],
    volumes: [{ container: "/data/db" }],
    env: [
      { name: "MONGO_INITDB_ROOT_USERNAME", label: "Root user", default: "" },
      { name: "MONGO_INITDB_ROOT_PASSWORD", label: "Root password", default: "" },
    ],
  },
  {
    id: "redis",
    title: "Redis",
    description: "In-memory key/value store with append-only persistence.",
    categories: ["database", "cache"],
    logo: icon("redis"),
    image: "redis:7-alpine",
    ports: ["6379/tcp"],
    volumes: [{ container: "/data" }],
    command: "redis-server --appendonly yes",
  },
  {
    id: "valkey",
    title: "Valkey",
    description: "Open-source Redis fork by the Linux Foundation.",
    categories: ["database", "cache"],
    image: "valkey/valkey:8-alpine",
    ports: ["6379/tcp"],
    volumes: [{ container: "/data" }],
  },
  {
    id: "memcached",
    title: "Memcached",
    description: "Distributed memory object cache.",
    categories: ["cache"],
    image: "memcached:1-alpine",
    ports: ["11211/tcp"],
  },
  {
    id: "clickhouse",
    title: "ClickHouse",
    description: "Column-oriented analytics database. HTTP on 8123, native protocol on 9000.",
    categories: ["database", "analytics"],
    logo: icon("clickhouse"),
    image: "clickhouse/clickhouse-server:latest",
    ports: ["8123/tcp", "9000/tcp"],
    volumes: [{ container: "/var/lib/clickhouse" }],
    env: [{ name: "CLICKHOUSE_PASSWORD", label: "Password for user default", secret: true }],
  },
  {
    id: "rabbitmq",
    title: "RabbitMQ",
    description: "Message broker with the management UI on port 15672 (guest/guest).",
    categories: ["messaging"],
    logo: icon("rabbitmq"),
    image: "rabbitmq:4-management-alpine",
    ports: ["5672/tcp", "15672/tcp"],
    volumes: [{ container: "/var/lib/rabbitmq" }],
  },
  {
    id: "nats",
    title: "NATS",
    description: "Lightweight messaging with JetStream enabled. Monitoring on port 8222.",
    categories: ["messaging"],
    logo: icon("natsdotio"),
    image: "nats:2-alpine",
    ports: ["4222/tcp", "8222/tcp"],
    command: "-js -m 8222",
  },
  {
    id: "minio",
    title: "MinIO",
    description: "S3-compatible object storage. API on 9000, console on 9001.",
    categories: ["storage"],
    logo: icon("minio"),
    image: "minio/minio:latest",
    ports: ["9000/tcp", "9001/tcp"],
    volumes: [{ container: "/data" }],
    command: 'server /data --console-address ":9001"',
    env: [
      { name: "MINIO_ROOT_USER", label: "Root user", default: "minioadmin" },
      { name: "MINIO_ROOT_PASSWORD", label: "Root password", secret: true },
    ],
  },
  {
    id: "nginx",
    title: "Nginx",
    description: "Web server. Mount a folder on /usr/share/nginx/html to serve it.",
    categories: ["web"],
    logo: icon("nginx"),
    image: "nginx:alpine",
    ports: ["8080:80/tcp"],
  },
  {
    id: "caddy",
    title: "Caddy",
    description: "Web server with automatic HTTPS.",
    categories: ["web"],
    logo: icon("caddy"),
    image: "caddy:2-alpine",
    ports: ["80/tcp", "443/tcp"],
    volumes: [{ container: "/data" }, { container: "/config" }],
  },
  {
    id: "adminer",
    title: "Adminer",
    description: "Database management in a single page (MySQL, PostgreSQL, SQLite, …).",
    categories: ["database", "tools"],
    image: "adminer:latest",
    ports: ["8081:8080/tcp"],
  },
  {
    id: "mailpit",
    title: "Mailpit",
    description: "Email testing: SMTP on 1025, web UI on 8025.",
    categories: ["tools", "development"],
    image: "axllent/mailpit:latest",
    ports: ["1025/tcp", "8025/tcp"],
  },
  {
    id: "ollama",
    title: "Ollama",
    description: "Run large language models locally. API on 11434.",
    categories: ["ai"],
    logo: icon("ollama"),
    image: "ollama/ollama:latest",
    ports: ["11434/tcp"],
    volumes: [{ container: "/root/.ollama" }],
  },
  {
    id: "grafana",
    title: "Grafana",
    description: "Dashboards and observability (admin/admin on first login).",
    categories: ["monitoring"],
    logo: icon("grafana"),
    image: "grafana/grafana:latest",
    ports: ["3000/tcp"],
    volumes: [{ container: "/var/lib/grafana" }],
  },
  {
    id: "prometheus",
    title: "Prometheus",
    description: "Metrics collection and alerting.",
    categories: ["monitoring"],
    logo: icon("prometheus"),
    image: "prom/prometheus:latest",
    ports: ["9090/tcp"],
    volumes: [{ container: "/prometheus" }],
  },
  {
    id: "uptime-kuma",
    title: "Uptime Kuma",
    description: "Self-hosted uptime monitoring.",
    categories: ["monitoring"],
    logo: icon("uptimekuma"),
    image: "louislam/uptime-kuma:1",
    ports: ["3001/tcp"],
    volumes: [{ container: "/app/data" }],
  },
  {
    id: "n8n",
    title: "n8n",
    description: "Workflow automation.",
    categories: ["automation"],
    logo: icon("n8n"),
    image: "n8nio/n8n:latest",
    ports: ["5678/tcp"],
    volumes: [{ container: "/home/node/.n8n" }],
  },
  {
    id: "keycloak",
    title: "Keycloak",
    description: "Identity and access management (dev mode).",
    categories: ["security"],
    logo: icon("keycloak"),
    image: "quay.io/keycloak/keycloak:latest",
    ports: ["8080/tcp"],
    command: "start-dev",
    env: [
      { name: "KC_BOOTSTRAP_ADMIN_USERNAME", label: "Admin user", default: "admin" },
      { name: "KC_BOOTSTRAP_ADMIN_PASSWORD", label: "Admin password", secret: true },
    ],
  },
  {
    id: "registry",
    title: "Docker Registry",
    description: "Private image registry.",
    categories: ["docker"],
    logo: icon("docker"),
    image: "registry:2",
    ports: ["5000/tcp"],
    volumes: [{ container: "/var/lib/registry" }],
  },
  {
    id: "ubuntu",
    title: "Ubuntu shell",
    description: "Long-running Ubuntu container to exec into.",
    categories: ["operating-system"],
    logo: icon("ubuntu"),
    image: "ubuntu:24.04",
    interactive: true,
    restart: "no",
  },
].map((t) => ({ ...t, source: "builtin", kind: "container" }) as ContainerTemplate);

const COMPOSE: ContainerTemplate[] = [
  {
    id: "postgres-pgadmin",
    title: "PostgreSQL + pgAdmin",
    description: "PostgreSQL on 5432 with pgAdmin on http://localhost:5050.",
    categories: ["database"],
    logo: icon("postgresql"),
    env: [
      { name: "POSTGRES_PASSWORD", label: "Database password", secret: true },
      { name: "PGADMIN_EMAIL", label: "pgAdmin email", default: "admin@example.com" },
      { name: "PGADMIN_PASSWORD", label: "pgAdmin password", secret: true },
    ],
    compose: `services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
  pgadmin:
    image: dpage/pgadmin4:latest
    restart: unless-stopped
    environment:
      PGADMIN_DEFAULT_EMAIL: \${PGADMIN_EMAIL}
      PGADMIN_DEFAULT_PASSWORD: \${PGADMIN_PASSWORD}
    ports:
      - "5050:80"
    depends_on:
      - postgres
volumes:
  pgdata:
`,
  },
  {
    id: "mongo-express",
    title: "MongoDB + Mongo Express",
    description: "MongoDB on 27017 with the Mongo Express admin UI on http://localhost:8081.",
    categories: ["database"],
    logo: icon("mongodb"),
    env: [
      { name: "MONGO_USER", label: "Root user", default: "root" },
      { name: "MONGO_PASSWORD", label: "Root password", secret: true },
    ],
    compose: `services:
  mongo:
    image: mongo:8
    restart: unless-stopped
    environment:
      MONGO_INITDB_ROOT_USERNAME: \${MONGO_USER}
      MONGO_INITDB_ROOT_PASSWORD: \${MONGO_PASSWORD}
    ports:
      - "27017:27017"
    volumes:
      - mongodata:/data/db
  mongo-express:
    image: mongo-express:latest
    restart: unless-stopped
    environment:
      ME_CONFIG_MONGODB_URL: mongodb://\${MONGO_USER}:\${MONGO_PASSWORD}@mongo:27017/
      ME_CONFIG_BASICAUTH: "false"
    ports:
      - "8081:8081"
    depends_on:
      - mongo
volumes:
  mongodata:
`,
  },
  {
    id: "mysql-phpmyadmin",
    title: "MySQL + phpMyAdmin",
    description: "MySQL on 3306 with phpMyAdmin on http://localhost:8082.",
    categories: ["database"],
    logo: icon("mysql"),
    env: [{ name: "MYSQL_ROOT_PASSWORD", label: "Root password", secret: true }],
    compose: `services:
  mysql:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD}
    ports:
      - "3306:3306"
    volumes:
      - mysqldata:/var/lib/mysql
  phpmyadmin:
    image: phpmyadmin:latest
    restart: unless-stopped
    environment:
      PMA_HOST: mysql
    ports:
      - "8082:80"
    depends_on:
      - mysql
volumes:
  mysqldata:
`,
  },
  {
    id: "redis-insight",
    title: "Redis + RedisInsight",
    description: "Redis on 6379 with RedisInsight on http://localhost:5540 (add host \"redis\").",
    categories: ["database", "cache"],
    logo: icon("redis"),
    compose: `services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --appendonly yes
    ports:
      - "6379:6379"
    volumes:
      - redisdata:/data
  redisinsight:
    image: redis/redisinsight:latest
    restart: unless-stopped
    ports:
      - "5540:5540"
    volumes:
      - insightdata:/data
volumes:
  redisdata:
  insightdata:
`,
  },
  {
    id: "wordpress",
    title: "WordPress + MariaDB",
    description: "WordPress on http://localhost:8083 backed by MariaDB.",
    categories: ["cms", "web"],
    logo: icon("wordpress"),
    env: [{ name: "DB_PASSWORD", label: "Database password", secret: true }],
    compose: `services:
  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: \${DB_PASSWORD}
      MARIADB_DATABASE: wordpress
      MARIADB_USER: wordpress
      MARIADB_PASSWORD: \${DB_PASSWORD}
    volumes:
      - dbdata:/var/lib/mysql
  wordpress:
    image: wordpress:latest
    restart: unless-stopped
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
      WORDPRESS_DB_NAME: wordpress
    ports:
      - "8083:80"
    volumes:
      - wpdata:/var/www/html
    depends_on:
      - db
volumes:
  dbdata:
  wpdata:
`,
  },
  {
    id: "ollama-open-webui",
    title: "Ollama + Open WebUI",
    description: "Local LLMs with a ChatGPT-style UI on http://localhost:3080.",
    categories: ["ai"],
    logo: icon("ollama"),
    compose: `services:
  ollama:
    image: ollama/ollama:latest
    restart: unless-stopped
    ports:
      - "11434:11434"
    volumes:
      - ollama:/root/.ollama
  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    restart: unless-stopped
    environment:
      OLLAMA_BASE_URL: http://ollama:11434
    ports:
      - "3080:8080"
    volumes:
      - webui:/app/backend/data
    depends_on:
      - ollama
volumes:
  ollama:
  webui:
`,
  },
  {
    id: "prometheus-grafana",
    title: "Prometheus + Grafana",
    description: "Metrics on http://localhost:9090 and dashboards on http://localhost:3000 (admin/admin).",
    categories: ["monitoring"],
    logo: icon("grafana"),
    compose: `services:
  prometheus:
    image: prom/prometheus:latest
    restart: unless-stopped
    ports:
      - "9090:9090"
    volumes:
      - prometheus:/prometheus
  grafana:
    image: grafana/grafana:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - grafana:/var/lib/grafana
    depends_on:
      - prometheus
volumes:
  prometheus:
  grafana:
`,
  },
  {
    id: "kafka",
    title: "Kafka (KRaft) + Kafka UI",
    description: "Single-node Apache Kafka on 9092 without ZooKeeper, with Kafka UI on http://localhost:8084.",
    categories: ["messaging"],
    logo: icon("apachekafka"),
    compose: `services:
  kafka:
    image: apache/kafka:latest
    restart: unless-stopped
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:9092,INTERNAL://:29092,CONTROLLER://:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092,INTERNAL://kafka:29092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT
      KAFKA_INTER_BROKER_LISTENER_NAME: INTERNAL
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
    ports:
      - "9092:9092"
  kafka-ui:
    image: provectuslabs/kafka-ui:latest
    restart: unless-stopped
    environment:
      KAFKA_CLUSTERS_0_NAME: local
      KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: kafka:29092
    ports:
      - "8084:8080"
    depends_on:
      - kafka
`,
  },
  {
    id: "gitea",
    title: "Gitea + PostgreSQL",
    description: "Self-hosted Git service on http://localhost:3002 (SSH on 2222).",
    categories: ["development"],
    logo: icon("gitea"),
    env: [{ name: "DB_PASSWORD", label: "Database password", secret: true }],
    compose: `services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: gitea
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      POSTGRES_DB: gitea
    volumes:
      - dbdata:/var/lib/postgresql/data
  gitea:
    image: gitea/gitea:latest
    restart: unless-stopped
    environment:
      GITEA__database__DB_TYPE: postgres
      GITEA__database__HOST: db:5432
      GITEA__database__NAME: gitea
      GITEA__database__USER: gitea
      GITEA__database__PASSWD: \${DB_PASSWORD}
    ports:
      - "3002:3000"
      - "2222:22"
    volumes:
      - gitea:/data
    depends_on:
      - db
volumes:
  dbdata:
  gitea:
`,
  },
].map((t) => ({ ...t, source: "builtin", kind: "compose" }) as ContainerTemplate);

export const BUILTIN_TEMPLATES: readonly ContainerTemplate[] = [...CONTAINERS, ...COMPOSE];
