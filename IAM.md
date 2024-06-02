
# Attaching an IAM Role to Single / Multiple IAM User? Users in AWS

```
Let's take a scenario where Naveen, a user with full admin-level access to an AWS account, needs to attach an IAM role to an existing IAM user, Komal, who currently has no access to resources.

```

Save this script in a file, for example, `install_docker.sh`, and make it executable using:

```bash
chmod +x install_docker.sh
```

Then, you can run the script using:

```bash
./install_docker.sh
```

## Create Sonarqube Docker container
To run SonarQube in a Docker container with the provided command, you can follow these steps:

1. Open your terminal or command prompt.

2. Run the following command:

```bash
docker run -d --name sonar -p 9000:9000 sonarqube:lts-community
```

This command will download the `sonarqube:lts-community` Docker image from Docker Hub if it's not already available locally. Then, it will create a container named "sonar" from this image, running it in detached mode (`-d` flag) and mapping port 9000 on the host machine to port 9000 in the container (`-p 9000:9000` flag).

3. Access SonarQube by opening a web browser and navigating to `http://VmIP:9000`.

This will start the SonarQube server, and you should be able to access it using the provided URL. If you're running Docker on a remote server or a different port, replace `localhost` with the appropriate hostname or IP address and adjust the port accordingly.
